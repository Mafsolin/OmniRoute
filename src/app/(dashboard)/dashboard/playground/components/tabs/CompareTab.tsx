"use client";

// src/app/(dashboard)/dashboard/playground/components/tabs/CompareTab.tsx

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import CompareColumn, { type CompareColumnData, type ColumnStatus } from "../CompareColumn";
import type { ConfigState } from "../StudioConfigPane";
import type { StreamMetrics } from "@/shared/schemas/playground";
import { DeliveryTracker } from "@/lib/playground/deliveryMetrics";
import { consumeChatStream, type ToolCall } from "@/lib/playground/consumeChatStream";
import { getProviderPricing } from "@/lib/playground/types";
import MarkdownMessage from "../MarkdownMessage";
import { buildPlaygroundChatRequest } from "@/lib/playground/chatRequest";
import { useAvailableModels } from "@/app/(dashboard)/dashboard/translator/hooks/useAvailableModels";
import { resolveReasoningControls } from "../reasoningControlUtils";

interface CompareTabProps {
  configState: ConfigState;
}

const MAX_COLUMNS = 4; // D10: cap at 4 columns

interface ColumnState {
  id: string;
  model: string;
  status: ColumnStatus;
  metrics: StreamMetrics;
  response: string;
  errorMessage?: string;
  toolCalls?: ToolCall[];
  events?: Array<{ event: string; payload: Record<string, unknown> }>;
}

const INITIAL_METRICS: StreamMetrics = {
  ttftMs: null,
  totalMs: null,
  tokensIn: 0,
  tokensOut: 0,
  tps: null,
  costUsd: null,
};

function createColumnId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `compare-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * CompareTab — up to 4 parallel streaming columns (D10 + D19 + D22).
 *
 * Streaming uses native fetch + ReadableStream (not EventSource).
 * Each column has its own AbortController.
 * Cmd+K (or Ctrl+K) focuses the "add column" model input.
 */
export default function CompareTab({ configState }: CompareTabProps) {
  const t = useTranslations("playground");
  const { modelCapabilities, loading: loadingModels } = useAvailableModels();
  const [columns, setColumns] = useState<ColumnState[]>(() => [
    {
      id: createColumnId(),
      model: configState.model,
      status: "idle",
      metrics: INITIAL_METRICS,
      response: "",
    },
  ]);

  // AbortControllers per column id
  const controllersRef = useRef<Map<string, AbortController>>(new Map());


  // User prompt input
  const [prompt, setPrompt] = useState("");

  // RAF throttle: pending chunk accumulator and scheduled frame id
  const pendingRef = useRef<Record<string, string>>({});
  const rafRef = useRef<number | null>(null);

  // Input for model name when adding a column
  const [newModel, setNewModel] = useState("");
  const addInputRef = useRef<HTMLInputElement>(null);

  // Cmd+K / Ctrl+K shortcut to focus model input (D10)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        addInputRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  /**
   * Throttle per-column chunk updates via requestAnimationFrame.
   * Accumulates all deltas that arrive within a single frame and flushes
   * them with a single setColumns call, preventing hundreds of re-renders/s.
   */
  function pushChunk(colId: string, delta: string) {
    pendingRef.current[colId] = (pendingRef.current[colId] ?? "") + delta;

    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        const snapshot = pendingRef.current;
        pendingRef.current = {};
        rafRef.current = null;

        setColumns((prev) =>
          prev.map((c) => {
            const extra = snapshot[c.id];
            return extra != null ? { ...c, response: c.response + extra } : c;
          })
        );
      });
    }
  }

  function addColumn() {
    if (columns.length >= MAX_COLUMNS) return;
    const model = newModel.trim() || configState.model;
    const id = createColumnId();
    setColumns((prev) => [
      ...prev,
      { id, model, status: "idle", metrics: INITIAL_METRICS, response: "" },
    ]);
    setNewModel("");
  }

  function removeColumn(id: string) {
    controllersRef.current.get(id)?.abort();
    controllersRef.current.delete(id);
    delete pendingRef.current[id];
    setColumns((prev) => prev.filter((c) => c.id !== id));
  }

  function cancelColumn(id: string) {
    controllersRef.current.get(id)?.abort();
  }

  function cancelAll() {
    for (const ctrl of controllersRef.current.values()) {
      ctrl.abort();
    }
  }

  function updateColumn(id: string, patch: Partial<ColumnState>) {
    setColumns((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  /**
   * Stream a single column's SSE request (D19).
   */
  async function streamColumn(col: ColumnState): Promise<void> {
    const capabilities = modelCapabilities[col.model];
    const spec = resolveReasoningControls(capabilities);
    if (loadingModels || typeof capabilities?.supportsThinking !== "boolean" ||
        (configState.params.effort && (!spec.show || !spec.effortOptions.includes(configState.params.effort))) ||
        (configState.params.thinking && !spec.show)) {
      updateColumn(col.id, { status: "error", errorMessage: t("modelParametersUnconfirmed") });
      return;
    }
    const controller = new AbortController();
    controllersRef.current.set(col.id, controller);
    const tracker = new DeliveryTracker();
    const current = () => controllersRef.current.get(col.id) === controller;
    const publish = (patch: Partial<ColumnState>) => { if (current()) updateColumn(col.id, patch); };
    delete pendingRef.current[col.id];
    publish({ status: "streaming", response: "", metrics: INITIAL_METRICS, errorMessage: undefined, toolCalls: [], events: [] });
    const body = buildPlaygroundChatRequest(configState, [{ role: "user", content: prompt }], col.model, spec);
    let accumulated = "";
    let toolCalls: ToolCall[] = [];
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    try {
      const res = await fetch("/api/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => t("unknownError"));
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      if (!res.body) throw new Error(t("noResponseBody"));
      const result = await consumeChatStream(res.body, {
        onEvent: () => tracker.event(),
        onReasoning: () => tracker.reasoning(),
        onFrame: (event, payload) => { events.push({ event, payload }); },
        onTools: tools => { tracker.tool(); toolCalls = tools; },
        onText: delta => {
          tracker.text(); accumulated += delta;
          if (current()) pushChunk(col.id, delta);
        },
      }, controller.signal);
      delete pendingRef.current[col.id];
      const warning = result.finishReason === "length"
        ? !result.hasText && !result.hasTools && result.hasReasoning ? t("reasoningLimitReached") : t("outputLimitReached")
        : result.finishReason === "content_filter" ? t("outputFiltered") : undefined;
      publish({ status: warning ? "error" : "done", errorMessage: warning, response: accumulated, toolCalls, events,
        metrics: tracker.finish(result.usage, getProviderPricing(col.model) ?? undefined) });
    } catch (err) {
      if (current()) delete pendingRef.current[col.id];
      publish({ status: "error", response: accumulated, toolCalls, events,
        errorMessage: controller.signal.aborted ? t("requestCancelled") : err instanceof Error ? err.message : String(err),
        metrics: tracker.finish() });
    } finally {
      if (current()) controllersRef.current.delete(col.id);
    }
  }

  /**
   * Run all columns in parallel (D10).
   */
  async function runAll() {
    cancelAll();
    await Promise.allSettled(columns.map((col) => streamColumn(col)));
  }

  const isAnyStreaming = columns.some((c) => c.status === "streaming");
  const atColumnLimit = columns.length >= MAX_COLUMNS;

  const displayColumns: CompareColumnData[] = columns.map((c) => ({
    id: c.id,
    model: c.model,
    status: c.status,
    metrics: c.metrics,
    response: c.response,
    errorMessage: c.errorMessage,
  }));

  return (
    <div className="flex flex-col h-full">
      {/* Prompt input area */}
      <div className="px-4 pt-3 pb-2 border-b border-border bg-bg-alt shrink-0">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("comparePromptPlaceholder")}
          rows={3}
          className="w-full text-sm bg-surface border border-border rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary text-text-main resize-y"
          aria-label={t("userPrompt")}
        />
      </div>

      {/* Compare toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-bg-alt shrink-0">
        {/* Run / Cancel all */}
        {isAnyStreaming ? (
          <button
            onClick={cancelAll}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-destructive/10 text-destructive border border-destructive/30 hover:bg-destructive/20 transition-colors"
            aria-label={t("cancelAllStreams")}
          >
            <span className="material-symbols-outlined text-[14px]">stop</span>
            {t("cancelAll")}
          </button>
        ) : (
          <button
            onClick={() => void runAll()}
            disabled={columns.length === 0 || !prompt.trim()}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label={t("runAllColumns")}
          >
            <span className="material-symbols-outlined text-[14px]">play_arrow</span>
            {t("runAll")}
          </button>
        )}

        {/* Add column */}
        <div className="flex items-center gap-1.5 ml-2">
          <input
            ref={addInputRef}
            type="text"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addColumn();
            }}
            placeholder={t("modelPlaceholderCompare")}
            disabled={atColumnLimit}
            className="text-xs bg-surface border border-border rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary text-text-main w-40 disabled:opacity-40"
            aria-label={t("newColumnModelName")}
          />
          <button
            onClick={addColumn}
            disabled={atColumnLimit}
            className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded border border-border text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={atColumnLimit ? t("maxColumnsReached", { max: MAX_COLUMNS }) : t("addColumn")}
            aria-label={t("addModelColumn")}
          >
            <span className="material-symbols-outlined text-[14px]">add</span>
            {t("addModel")}
          </button>
        </div>

        {/* Column count indicator */}
        <span className="ml-auto text-[11px] text-text-muted">
          {t("columnCount", { count: columns.length, max: MAX_COLUMNS })}
        </span>
      </div>

      {/* Columns area */}
      <div
        className="flex-1 grid overflow-hidden"
        style={{
          gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, minmax(0, 1fr))`,
        }}
      >
        {displayColumns.map((col) => (
          <div key={col.id} className="flex flex-col min-h-0 min-w-0 overflow-y-auto">
            <div className="flex-1 min-h-0">
              <CompareColumn column={col} onCancel={cancelColumn} onRemove={removeColumn} />
            </div>
            {col.status === "error" && col.response && <div className="px-3 py-3"><MarkdownMessage content={col.response} /></div>}
            {(columns.find(c => c.id === col.id)?.events?.length ?? 0) > 0 && <details className="px-3 py-2 text-xs text-text-muted">
              <summary className="cursor-pointer">{t("responseInspector")}</summary>
              {(columns.find(c => c.id === col.id)?.toolCalls?.length ?? 0) > 0 && <>
                <p>{t("toolHandoff")}</p>
                <pre data-testid="compare-tool-calls" className="whitespace-pre-wrap break-all">{JSON.stringify(columns.find(c => c.id === col.id)?.toolCalls, null, 2)}</pre>
              </>}
              <pre data-testid="compare-response-events" className="whitespace-pre-wrap break-all">{JSON.stringify(columns.find(c => c.id === col.id)?.events, null, 2)}</pre>
            </details>}
          </div>
        ))}

        {columns.length === 0 && (
          <div className="flex items-center justify-center h-full text-text-muted col-span-4">
            <div className="text-center space-y-2">
              <span className="material-symbols-outlined text-[48px] text-text-muted/30">
                compare
              </span>
              <p className="text-sm">{t("addModelToCompare")}</p>
              <p className="text-xs text-text-muted/60">
                {t("modelsSimultaneously", { max: MAX_COLUMNS })}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
