/**
 * db/settings/pricing.ts — Pricing data CRUD (user overrides, LiteLLM sync, models.dev sync).
 */

import { getDbInstance } from "../core";
import { backupDbFile } from "../backup";
import { getCachedPricing, invalidateDbCache } from "../readCache";
import { PROVIDER_ID_TO_ALIAS } from "@omniroute/open-sse/config/providerModels.ts";
import { type JsonRecord, toRecord } from "./shared";

type PricingModels = Record<string, JsonRecord>;
type PricingByProvider = Record<string, PricingModels>;
export type PricingSource = "default" | "litellm" | "modelsDev" | "user";
export type PricingSourceMap = Record<string, Record<string, PricingSource>>;

function readPricingNamespace(
  db: ReturnType<typeof getDbInstance>,
  namespace: string
): PricingByProvider {
  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = ?").all(namespace);
  const pricing: PricingByProvider = {};

  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;

    try {
      pricing[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
    } catch {
      // Corrupted data — skip silently, fallback to lower layers
    }
  }

  return pricing;
}

function mergePricingLayers(layers: PricingByProvider[]): PricingByProvider {
  const mergedPricing: PricingByProvider = {};

  for (const layer of layers) {
    for (const [provider, models] of Object.entries(layer)) {
      if (!mergedPricing[provider]) {
        mergedPricing[provider] = { ...models };
        continue;
      }

      for (const [model, pricing] of Object.entries(models)) {
        mergedPricing[provider][model] = mergedPricing[provider][model]
          ? { ...(mergedPricing[provider][model] || {}), ...toRecord(pricing) }
          : pricing;
      }
    }
  }

  return mergedPricing;
}

function buildPricingSourceMap(layers: {
  defaults: PricingByProvider;
  litellm: PricingByProvider;
  modelsDev: PricingByProvider;
  user: PricingByProvider;
}): PricingSourceMap {
  const sourceMap: PricingSourceMap = {};
  const mergedPricing = mergePricingLayers([
    layers.defaults,
    layers.litellm,
    layers.modelsDev,
    layers.user,
  ]);

  for (const [provider, models] of Object.entries(mergedPricing)) {
    sourceMap[provider] = {};

    for (const model of Object.keys(models)) {
      if (layers.user[provider]?.[model]) {
        sourceMap[provider][model] = "user";
      } else if (layers.modelsDev[provider]?.[model]) {
        sourceMap[provider][model] = "modelsDev";
      } else if (layers.litellm[provider]?.[model]) {
        sourceMap[provider][model] = "litellm";
      } else {
        sourceMap[provider][model] = "default";
      }
    }
  }

  return sourceMap;
}

async function getPricingLayers() {
  const db = getDbInstance();

  // Layer 1: Hardcoded defaults (lowest priority)
  const { getDefaultPricing } = await import("@/shared/constants/pricing");
  return {
    defaults: getDefaultPricing(),
    litellm: readPricingNamespace(db, "pricing_synced"),
    modelsDev: readPricingNamespace(db, "models_dev_pricing"),
    user: readPricingNamespace(db, "pricing"),
  };
}

export async function getPricing() {
  const layers = await getPricingLayers();
  // Merge: defaults → LiteLLM → models.dev → user (each layer overrides the previous)
  return mergePricingLayers([layers.defaults, layers.litellm, layers.modelsDev, layers.user]);
}

export async function getPricingWithSources(): Promise<{
  pricing: PricingByProvider;
  sourceMap: PricingSourceMap;
}> {
  const layers = await getPricingLayers();
  return {
    pricing: mergePricingLayers([layers.defaults, layers.litellm, layers.modelsDev, layers.user]),
    sourceMap: buildPricingSourceMap(layers),
  };
}

type PricingModelIndex = PricingModels | Map<string, JsonRecord>;
type PricingIndexes = {
  // Only keys that actually occur in the pricing snapshot live here.
  providers: Map<string, PricingModelIndex>;
  // Resolved public ids/aliases and negative lookups are kept separately so a
  // miss for one spelling cannot become a false hit for another spelling.
  resolved: Map<string, PricingModelIndex | null>;
};

const modelPricingIndexes = new WeakMap<object, PricingIndexes>();

export async function getPricingForModel(provider: string, model: string) {
  const pricing = (await getCachedPricing()) as PricingByProvider;
  let indexes = modelPricingIndexes.get(pricing);
  if (!indexes) {
    const providers = new Map<string, PricingModelIndex>();
    for (const [name, models] of Object.entries(pricing)) {
      const key = name.toLowerCase();
      if (!providers.has(key)) {
        // Lazily index a provider only when it is requested.
        providers.set(key, models);
      }
    }
    indexes = { providers, resolved: new Map() };
    modelPricingIndexes.set(pricing, indexes);
  }

  const pLower = (provider || "").toLowerCase();
  let models: PricingModelIndex | null | undefined;
  if (indexes.resolved.has(pLower)) {
    models = indexes.resolved.get(pLower);
  } else {
    let providerKey = indexes.providers.has(pLower) ? pLower : null;
    if (!providerKey) {
      const alias = Object.entries(PROVIDER_ID_TO_ALIAS).find(
        ([id]) => id.toLowerCase() === pLower
      )?.[1];
      if (alias && indexes.providers.has(alias.toLowerCase())) {
        providerKey = alias.toLowerCase();
      }
    }
    if (!providerKey) {
      for (const [id, alias] of Object.entries(PROVIDER_ID_TO_ALIAS)) {
        if (typeof alias === "string" && alias.toLowerCase() === pLower) {
          if (indexes.providers.has(id.toLowerCase())) {
            providerKey = id.toLowerCase();
          }
          break;
        }
      }
    }
    if (!providerKey) {
      const withoutCn = pLower.replace(/-cn$/, "");
      if (withoutCn !== pLower && indexes.providers.has(withoutCn)) {
        providerKey = withoutCn;
      }
    }
    models = providerKey ? indexes.providers.get(providerKey) ?? null : null;
    indexes.resolved.set(pLower, models);
  }

  if (!models) return null;
  if (!(models instanceof Map)) {
    const indexed = new Map<string, JsonRecord>();
    for (const [name, value] of Object.entries(models)) {
      const key = name.toLowerCase();
      if (!indexed.has(key)) indexed.set(key, value);
    }
    const providerKey = [...indexes.providers.entries()].find(([, value]) => value === models)?.[0];
    if (providerKey) indexes.providers.set(providerKey, indexed);
    indexes.resolved.set(pLower, indexed);
    models = indexed;
  }
  const mLower = (model || "").toLowerCase();
  return models.get(mLower) || models.get(mLower.replace(/\./g, "-")) || null;
}

export async function updatePricing(pricingData: PricingByProvider) {
  const db = getDbInstance();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('pricing', ?, ?)"
  );

  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  const existing: PricingByProvider = {};
  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    existing[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
  }

  const tx = db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      insert.run(provider, JSON.stringify({ ...(existing[provider] || {}), ...models }));
    }
  });
  tx();
  backupDbFile("pre-write");
  invalidateDbCache("pricing"); // Bust the pricing read cache
  const updated: PricingByProvider = {};
  const allRows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  for (const row of allRows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    updated[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
  }
  return updated;
}

export async function resetPricing(provider: string, model?: string) {
  const db = getDbInstance();

  if (model) {
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = 'pricing' AND key = ?")
      .get(provider);
    if (row) {
      const rowRecord = toRecord(row);
      const value = typeof rowRecord.value === "string" ? rowRecord.value : "{}";
      const models = toRecord(JSON.parse(value));
      delete models[model];
      if (Object.keys(models).length === 0) {
        db.prepare("DELETE FROM key_value WHERE namespace = 'pricing' AND key = ?").run(provider);
      } else {
        db.prepare("UPDATE key_value SET value = ? WHERE namespace = 'pricing' AND key = ?").run(
          JSON.stringify(models),
          provider
        );
      }
    }
  } else {
    db.prepare("DELETE FROM key_value WHERE namespace = 'pricing' AND key = ?").run(provider);
  }

  backupDbFile("pre-write");
  invalidateDbCache("pricing");
  const allRows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  const result: Record<string, unknown> = {};
  for (const row of allRows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    result[key] = JSON.parse(rawValue);
  }
  return result;
}

export async function resetAllPricing() {
  const db = getDbInstance();
  db.prepare("DELETE FROM key_value WHERE namespace = 'pricing'").run();
  backupDbFile("pre-write");
  invalidateDbCache("pricing");
  return {};
}
