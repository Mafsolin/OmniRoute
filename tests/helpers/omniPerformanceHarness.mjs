// Behavioral fixtures for source and explicitly selected deployment artifacts.
// Only dependencies (pricing snapshot/model parser) are injected; the lookup
// implementations and their memo/index state are the real source/bundled code.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
export const deploymentOptions =
  process.env.OMNI_RUNTIME_DIR || process.env.OMNI_REQUIRE_RUNTIME === "1"
    ? {}
    : { skip: "Deployment NOT verified: set OMNI_RUNTIME_DIR to the candidate artifact" };
export const variants = ["source", "deployment"];

function commonJs(code, filename, dependencies) {
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require: () => dependencies,
    console,
  });
  vm.runInContext(code, context, { filename, timeout: 5000 });
  return module.exports;
}

let bundledDefinitions;
function definitions() {
  assert.ok(
    process.env.OMNI_RUNTIME_DIR,
    "Release gate requires OMNI_RUNTIME_DIR; skipped deployment checks are not release verification"
  );
  if (bundledDefinitions) return bundledDefinitions;
  const root = path.resolve(process.env.OMNI_RUNTIME_DIR);
  const server = [".build/next/server", ".next/server"]
    .map((p) => path.join(root, p))
    .find((p) => fs.existsSync(p));
  assert.ok(server, `No Next server artifact under candidate ${root}`);
  const chunks = path.join(server, "chunks");
  assert.ok(fs.existsSync(chunks), `No server chunks under candidate ${server}`);
  const output = [];
  function walk(dir) {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      const code = fs.readFileSync(file, "utf8");
      // Discover modules by public dependency/property names, never chunk IDs
      // or minifier-local identifiers. Route entrypoints are not executed.
      if (!code.includes("getCachedPricing") && !code.includes("aliasToProviderId")) continue;
      const chunk = commonJs(code, file, {});
      for (const [id, definition] of Object.entries(chunk.modules ?? {})) {
        if (typeof definition === "function") output.push({ file, id, definition });
      }
    }
  }
  walk(chunks);
  bundledDefinitions = output;
  return output;
}

function exportsFromDefinition(definition, dependencies) {
  const module = { exports: {} };
  const req = () => dependencies;
  req.d = (target, getters) => {
    for (const [name, get] of Object.entries(getters))
      Object.defineProperty(target, name, { enumerable: true, get });
  };
  req.r = (target) => Object.defineProperty(target, "__esModule", { value: true });
  req.n = (value) => {
    const getter = () => value;
    req.d(getter, { a: getter });
    return getter;
  };
  req.o = (object, key) => Object.hasOwn(object, key);
  definition(module, module.exports, req);
  return module.exports;
}

function loadLookups(kind, relativeSource, symbol, dependencies, matches) {
  if (kind === "source") {
    const file = path.join(sourceRoot, relativeSource);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      fileName: file,
    }).outputText;
    const lookup = commonJs(code, file, dependencies)[symbol];
    assert.equal(typeof lookup, "function", `${symbol} must be exported from this checkout`);
    return [{ name: relativeSource, lookup }];
  }
  const result = [];
  for (const { file, id, definition } of definitions()) {
    if (!matches(definition.toString())) continue;
    const exports = exportsFromDefinition(definition, dependencies);
    for (const [name, value] of Object.entries(exports)) {
      if (typeof value === "function" && (name === symbol || matches(value.toString()))) {
        result.push({ name: `${file}#${id}:${name}`, lookup: value });
      }
    }
  }
  assert.ok(
    result.length,
    `Candidate exports for ${symbol} not found; deployment is NOT verified (unsupported artifact format or missing function)`
  );
  return result;
}

export function pricingLookups(kind, getCachedPricing, aliases = {}) {
  return loadLookups(
    kind,
    "src/lib/db/settings/pricing.ts",
    "getPricingForModel",
    {
      getCachedPricing,
      PROVIDER_ID_TO_ALIAS: aliases,
    },
    (code) => code.includes("getCachedPricing") && code.includes("toLowerCase")
  );
}

export function prefixHarnesses(kind) {
  const aliases = Object.fromEntries(
    Array.from({ length: 1200 }, (_, i) => ["alias-" + i, "other-" + i])
  );
  Object.assign(aliases, {
    ag: "antigravity",
    antigravity: "antigravity",
    cx: "codex",
    codex: "codex",
  });
  let checks = 0,
    scans = 0;
  const maps = {
    aliasToProviderId: new Proxy(aliases, {
      ownKeys(target) {
        scans++;
        return Reflect.ownKeys(target);
      },
    }),
    providerIdToAlias: { antigravity: "ag", codex: "cx" },
  };
  const lookups = loadLookups(
    kind,
    "src/app/api/v1/models/catalogProviderMaps.ts",
    "getProviderPrefixes",
    {
      PROVIDER_MODELS: {},
      PROVIDER_ID_TO_ALIAS: {},
      AI_PROVIDERS: {},
      parseModel(input) {
        checks++;
        return { provider: aliases[input.split("/")[0]] };
      },
    },
    (code) =>
      code.includes("aliasToProviderId") &&
      code.includes("providerIdToAlias") &&
      code.includes("Object.entries") &&
      code.includes(".filter(")
  );
  return lookups.map((item) => ({ ...item, maps, counters: () => ({ checks, scans }) }));
}
