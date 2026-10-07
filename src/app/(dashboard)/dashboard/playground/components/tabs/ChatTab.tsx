"use client";

// src/app/(dashboard)/dashboard/playground/components/tabs/ChatTab.tsx

import { useState, useRef, useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import MarkdownMessage from "../MarkdownMessage";
import TokenCostCounter from "../TokenCostCounter";
import { useStreamMetrics } from "../../hooks/useStreamMetrics";
import { DeliveryTracker } from "@/lib/playground/deliveryMetrics";
import { getModelPricing } from "@/lib/playground/types";
import type { ConfigState } from "../StudioConfigPane";
import type { StreamMetrics } from "@/shared/schemas/playground";
import { buildPlaygroundChatRequest } from "@/lib/playground/chatRequest";
import { consumeChatStream, type ToolCall } from "@/lib/playground/consumeChatStream";
import {
  buildNonChatRequestBody,
  buildResponsesRequestBody,
  formatNonChatResponse,
  isChatCompletionsEndpoint,
  lastUserContent,
  resolveChatTabRequestPath,
} from "./chatTabEndpointRequest";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
  metrics?: StreamMetrics;
  toolCalls?: ToolCall[];
  events?: Array<{ event: string; payload: Record<string, unknown> }>;
}

interface ChatTabProps {
  configState: ConfigState;
  onMetricsUpdate?: (metrics: StreamMetrics) => void;
}

/** Frames retained for the debug inspector; the full log is capped so long streams stay linear. */
const MAX_INSPECTOR_EVENTS = 2000;
/** The inspector updates at most this often; re-serializing a growing log every frame is quadratic. */
const INSPECTOR_FLUSH_MS = 250;

/**
 * Response inspector — renders raw SSE frames only after the user opens it, so an
 * in-flight stream never pays JSON.stringify + a growing DOM node on every delta.
 */
function ResponseInspector({
  events,
  toolCalls,
}: {
  events?: Array<{ event: string; payload: Record<string, unknown> }>;
  toolCalls?: ToolCall[];
}) {
  const t = useTranslations("playground");
  const [open, setOpen] = useState(false);
  const eventsJson = useMemo(() => (open ? JSON.stringify(events ?? [], null, 2) : ""), [open, events]);
  const toolsJson = useMemo(() => (open ? JSON.stringify(toolCalls ?? [], null, 2) : ""), [open, toolCalls]);
  return (
    <details className="mt-1 w-full text-xs text-text-muted" open={open}>
      <summary
        className="cursor-pointer"
        onClick={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        {t("responseInspector")}
      </summary>
      {(toolCalls?.length ?? 0) > 0 && (
        <>
          <p>{t("toolHandoff")}</p>
          <pre data-testid="chat-tool-calls" className="whitespace-pre-wrap break-all">
            {toolsJson}
          </pre>
        </>
      )}
      <pre data-testid="chat-response-events" className="whitespace-pre-wrap break-all">
        {eventsJson}
      </pre>
    </details>
  );
}

/**
 * ChatTab — refactor of ChatPlayground.tsx with:
 * - System prompt from the config pane (configState.systemPrompt)
 * - Markdown rendering via MarkdownMessage (F1)
 * - Token/cost per message via useStreamMetrics (F5)
 * - Regenerate button
 */
export default function ChatTab({ configState, onMetricsUpdate }: ChatTabProps) {
  const t = useTranslations("playground");
  const pricing = getModelPricing(configState.model);
  const streamMetrics = useStreamMetrics(pricing ?? undefined);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [responseStatus, setResponseStatus] = useState<number | null>(null);
  const [responseDuration, setResponseDuration] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const clearedRef = useRef(false);

  /** Applies a patch to one assistant message; a cleared chat is never repopulated by an old stream. */
  const patchAssistant = (index: number, patch: Partial<Message>) =>
    setMessages((prev) => {
      if (index < 0 || index >= prev.length || prev[index]?.role !== "assistant") return prev;
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Build the messages array for the API, prepending system prompt
  function buildApiMessages(chatMessages: Message[]): Array<{ role: string; content: string }> {
    const out: Array<{ role: string; content: string }> = [];
    if (configState.systemPrompt.trim()) {
      out.push({ role: "system", content: configState.systemPrompt });
    }
    out.push(
      ...chatMessages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role,
          content: m.content,
        }))
    );
    return out;
  }

  function buildRequestBody(chatMessages: Message[]): Record<string, unknown> {
    return buildPlaygroundChatRequest(configState, chatMessages);
  }

  const doSend = async (chatMessages: Message[], appendIndex?: number) => {
    if (!configState.model) {
      setError(t("setModelInConfigFirst"));
      return;
    }

    setLoading(true);
    setError(null);
    setResponseStatus(null);

    const controller = new AbortController();
    abortRef.current = controller;
    clearedRef.current = false;
    const startTime = Date.now();

    streamMetrics.start();
    const tracker = new DeliveryTracker();

    // If regenerating, replace the last assistant message; otherwise append
    const targetIndex = appendIndex ?? chatMessages.length;
    setMessages((prev) => {
      const next = [...prev];
      if (appendIndex !== undefined && next[appendIndex]?.role === "assistant") {
        next[appendIndex] = { role: "assistant", content: "" };
      } else {
        next.push({ role: "assistant", content: "" });
      }
      return next;
    });

    try {
      const fetchHeaders: Record<string, string> = { "Content-Type": "application/json" };
      const isResponses = configState.endpoint === "responses";
      const streamingConversation = isChatCompletionsEndpoint(configState.endpoint) || isResponses;
      const requestBody = isResponses
        ? buildResponsesRequestBody(buildApiMessages(chatMessages), configState.model,
            configState.params,
            { effort: configState.params.effort, thinking: configState.params.thinking },
            configState.reasoning ?? { show: false, effortOptions: [] })
        : streamingConversation ? buildRequestBody(chatMessages)
        : buildNonChatRequestBody(
            configState.endpoint,
            lastUserContent(chatMessages),
            configState.model
          );

      const res = await fetch(resolveChatTabRequestPath(configState.endpoint), {
        method: "POST",
        headers: fetchHeaders,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      setResponseStatus(res.status);

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const errMsg: string =
          (errData as { error?: { message?: string } }).error?.message ||
          t("httpError", { status: res.status });
        setError(errMsg);
        setMessages((prev) => prev.slice(0, targetIndex));
        setLoading(false);
        setResponseDuration(Date.now() - startTime);
        streamMetrics.reset();
        return;
      }

      if (!streamingConversation) {
        const rawText = await res.text();
        patchAssistant(targetIndex, { content: formatNonChatResponse(rawText) });
        setResponseDuration(Date.now() - startTime);
        setLoading(false);
        streamMetrics.reset();
        return;
      }

      if (!res.body) throw new Error(t("noResponseBody"));
      let assistantResponse = "";
      const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
      let lastFlushAt = 0;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flushEvents = () => {
        lastFlushAt = Date.now();
        if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
        patchAssistant(targetIndex, { events: events.slice(-MAX_INSPECTOR_EVENTS) });
      };
      const scheduleEventsFlush = () => {
        const elapsed = Date.now() - lastFlushAt;
        if (elapsed >= INSPECTOR_FLUSH_MS) flushEvents();
        else if (flushTimer === null) flushTimer = setTimeout(flushEvents, INSPECTOR_FLUSH_MS - elapsed);
      };
      const result = await consumeChatStream(res.body, {
        onFrame: (event, payload) => {
          events.push({ event, payload });
          scheduleEventsFlush();
        },
        onTools: toolCalls => { tracker.tool(); patchAssistant(targetIndex, { toolCalls }); },
        onEvent: () => tracker.event(),
        onReasoning: () => tracker.reasoning(),
        onText: (delta) => {
          assistantResponse += delta;
          tracker.text();
          patchAssistant(targetIndex, { content: assistantResponse });
        },
      }, controller.signal);
      if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
      flushEvents();
      const usageData = result.usage;
      if (result.finishReason === "length" && !result.hasText && !result.hasTools && result.hasReasoning) setError(t("reasoningLimitReached"));
      else if (result.finishReason === "length") setError(t("outputLimitReached"));
      else if (result.finishReason === "content_filter") setError(t("outputFiltered"));

      const metricsSnapshot = tracker.finish(usageData, pricing ? { ...pricing, estimated: true } : undefined);
      streamMetrics.apply(metricsSnapshot);

      // Attach metrics to the assistant message
      patchAssistant(targetIndex, { metrics: metricsSnapshot });

      onMetricsUpdate?.(metricsSnapshot);
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      if (e.name === "AbortError") {
        if (!clearedRef.current) setError(t("requestCancelled"));
      } else {
        setError(e.message ?? t("networkError"));
      }
      streamMetrics.reset();
    }

    setResponseDuration(Date.now() - startTime);
    setLoading(false);
  };

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const userMessage: Message = { role: "user", content: input };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    await doSend(newMessages);
  };

  const handleRegenerate = async () => {
    if (loading) return;
    // Find last assistant message index
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx === -1) return;

    // Messages up to (not including) the last assistant message
    const contextMessages = messages.slice(0, lastAssistantIdx);
    await doSend(contextMessages, lastAssistantIdx);
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleClear = () => {
    // An in-flight stream must not keep writing into a chat that no longer holds its message.
    clearedRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setError(null);
    setResponseStatus(null);
    setResponseDuration(null);
    streamMetrics.reset();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const hasAssistantMessage = messages.some((m) => m.role === "assistant");

  return (
    <div className="flex flex-col h-full">
      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-bg-alt text-xs text-text-muted">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[16px]">chat</span>
          <span className="font-medium">{t("tabChat")}</span>
          {responseStatus !== null && (
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                responseStatus < 400
                  ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                  : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
              }`}
            >
              {responseStatus}
            </span>
          )}
          {responseDuration !== null && <span>{responseDuration}ms</span>}
        </div>
        <div className="flex items-center gap-2">
          {hasAssistantMessage && !loading && (
            <button
              onClick={() => void handleRegenerate()}
              className="flex items-center gap-1 text-xs text-text-muted hover:text-text-main transition-colors"
              title={t("regenerateLastResponse")}
            >
              <span className="material-symbols-outlined text-[14px]">refresh</span>
              {t("regenerate")}
            </button>
          )}
          <button
            onClick={handleClear}
            className="p-1 rounded hover:bg-red-500/10 text-text-muted hover:text-red-500 transition-colors"
            title={t("clearChat")}
          >
            <span className="material-symbols-outlined text-[16px]">delete</span>
          </button>
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && !loading && (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            <div className="text-center space-y-2">
              <span className="material-symbols-outlined text-[48px] text-text-muted/30">chat</span>
              <p>{t("startConversation")}</p>
              {!configState.model && (
                <p className="text-amber-500 text-xs">{t("setModelInConfigFirst")}</p>
              )}
            </div>
          </div>
        )}

        {messages.map((msg, i) => {
          if (msg.role === "system") return null;
          return (
            <div
              key={i}
              className={`flex flex-col max-w-[85%] ${
                msg.role === "user" ? "ml-auto items-end" : "mr-auto items-start"
              }`}
            >
              <span className="text-[10px] text-text-muted uppercase mb-1 px-1">
                {t(`role.${msg.role}`)}
              </span>
              <div
                className={`px-4 py-2.5 rounded-2xl text-sm ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground rounded-tr-sm"
                    : "bg-bg-alt border border-border text-text-main rounded-tl-sm"
                }`}
              >
                {msg.role === "assistant" ? (
                  <MarkdownMessage content={msg.content} />
                ) : (
                  <span className="whitespace-pre-wrap">{msg.content}</span>
                )}
              </div>
              {msg.role === "assistant" && (msg.events?.length ?? 0) > 0 && (
                <ResponseInspector events={msg.events} toolCalls={msg.toolCalls} />
              )}
              {/* Token/cost per message */}
              {msg.role === "assistant" && msg.metrics && (
                <div className="mt-1 px-1">
                  <TokenCostCounter
                    tokensIn={msg.metrics.tokensIn}
                    tokensOut={msg.metrics.tokensOut}
                    costUsd={msg.metrics.costUsd}
                  />
                </div>
              )}
            </div>
          );
        })}

        {/* Loading indicator */}
        {loading && messages[messages.length - 1]?.role === "user" && (
          <div className="flex flex-col max-w-[85%] mr-auto items-start">
            <span className="text-[10px] text-text-muted uppercase mb-1 px-1">
              {t("role.assistant")}
            </span>
            <div className="px-4 py-2 rounded-2xl text-sm bg-bg-alt border border-border rounded-tl-sm text-text-muted flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px] animate-spin">
                progress_activity
              </span>
              {t("generating")}
            </div>
          </div>
        )}

        {error && (
          <div className="text-center p-2 text-sm text-red-500 bg-red-500/10 rounded border border-red-500/20">
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="p-3 border-t border-border bg-bg-alt flex gap-2 shrink-0">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("typeMessageWithShortcut")}
          className="flex-1 min-h-[44px] max-h-[120px] bg-surface border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-y"
          rows={1}
          disabled={loading}
        />
        {loading ? (
          <button
            onClick={handleCancel}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm text-text-muted hover:text-text-main hover:bg-black/5 transition-colors shrink-0"
          >
            <span className="material-symbols-outlined text-[16px]">stop</span>
            {t("stop")}
          </button>
        ) : (
          <button
            onClick={() => void handleSend()}
            disabled={!input.trim()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary/90 transition-colors shrink-0"
          >
            <span className="material-symbols-outlined text-[16px]">send</span>
            {t("send")}
          </button>
        )}
      </div>
    </div>
  );
}
