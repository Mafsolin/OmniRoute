// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatTab from "../../../src/app/(dashboard)/dashboard/playground/components/tabs/ChatTab";
import { DEFAULT_PARAMS } from "../../../src/app/(dashboard)/dashboard/playground/components/ParamSliders";
import type { ConfigState } from "../../../src/app/(dashboard)/dashboard/playground/components/StudioConfigPane";

vi.mock("react-markdown", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("remark-gfm", () => ({ default: () => {} }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key === "send" ? "Send" : key === "stop" ? "Stop" : key }));

const enc = new TextEncoder();
const event = (j: unknown) => `data: ${JSON.stringify(j)}\r\n\r\n`;
const config: ConfigState = {
  endpoint: "chat.completions", baseUrl: "", model: "test/delivery",
  systemPrompt: "Keep the user instructions.", params: { ...DEFAULT_PARAMS },
  reasoning: { show: false, effortOptions: [] },
};
Element.prototype.scrollIntoView = vi.fn();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function installStream(payload: string, fragmentSize: number) {
  const bytes = enc.encode(payload);
  const fetchMock = vi.fn(async () => new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += fragmentSize) controller.enqueue(bytes.slice(i, i + fragmentSize));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
async function send() {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "synthetic check" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /send/i })); });
}

describe("ChatTab delivery", () => {
  it("preserves UTF-8 text across arbitrary network boundaries", async () => {
    installStream(": keepalive\r\n\r\n" + event({ choices: [{ delta: { role: "assistant" } }] }) +
      event({ choices: [{ delta: { content: "Ответ 🌿" } }] }) +
      event({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 0 } } }) + "data: [DONE]\r\n\r\n", 1);
    render(<ChatTab configState={config} />);
    await send();
    await waitFor(() => expect(screen.getByText("Ответ 🌿")).toBeTruthy());
  });
  it("shows an in-stream error and keeps text already received", async () => {
    installStream(event({ choices: [{ delta: { content: "Частичный ответ" } }] }) +
      event({ error: { message: "synthetic upstream failure", code: "upstream_error" } }) + "data: [DONE]\r\n\r\n", 11);
    render(<ChatTab configState={config} />);
    await send();
    await waitFor(() => expect(screen.getByText("Частичный ответ")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("synthetic upstream failure", { exact: true })).toBeTruthy());
  });
  it("retains indexed tool arguments and raw events in the response inspector", async () => {
    installStream(event({ choices: [{ delta: { tool_calls: [
      { index: 1, id: "call_b", type: "function", function: { name: "second", arguments: '{"b":' } },
      { index: 0, id: "call_a", type: "function", function: { name: "first", arguments: '{"a":' } },
    ] } }] }) + event({ choices: [{ delta: { tool_calls: [
      { index: 0, function: { arguments: "1}" } }, { index: 1, function: { arguments: "2}" } },
    ] } }] }) + event({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\r\n\r\n", 7);
    render(<ChatTab configState={config} />);
    await send();
    fireEvent.click(await screen.findByText("responseInspector"));
    await waitFor(() => expect(screen.getByText("toolHandoff")).toBeTruthy());
    const tools = JSON.parse(screen.getByTestId("chat-tool-calls").textContent!);
    expect(tools.map((x: any) => [x.id, x.function.name, x.function.arguments])).toEqual([
      ["call_a", "first", '{"a":1}'], ["call_b", "second", '{"b":2}'],
    ]);
    expect(screen.getByTestId("chat-response-events").textContent).toContain("tool_calls");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
  it("reports current final metrics, not the previous React render", async () => {
    const onMetrics = vi.fn();
    installStream(event({ choices: [{ delta: { content: "metered" } }] }) + event({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 30 } }) + "data: [DONE]\n\n", 9);
    render(<ChatTab configState={{ ...config, model: "gpt-4o" }} onMetricsUpdate={onMetrics} />);
    await send();
    await waitFor(() => expect(onMetrics).toHaveBeenCalledTimes(1));
    expect(onMetrics.mock.calls[0][0].totalMs).not.toBeNull();
    expect(onMetrics.mock.calls[0][0].tokensOut).toBe(30);
    expect(onMetrics.mock.calls[0][0].costUsd).toBeCloseTo(0.0004);
  });
  it("separates first JSON event and reasoning from first visible text", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const onMetrics = vi.fn();
    const frames = [": keepalive\n\n", event({ choices: [{ delta: { role: "assistant" } }] }), event({ choices: [{ delta: { reasoning_content: "thinking" } }] }), event({ choices: [{ delta: { content: "visible" } }] }), event({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n"];
    const times = [10, 20, 100, 5000, 6000];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull(c) { now = times.shift() ?? 6000; const frame = frames.shift(); if (frame) c.enqueue(enc.encode(frame)); else c.close(); },
    }, { highWaterMark: 0 }))));
    render(<ChatTab configState={config} onMetricsUpdate={onMetrics} />);
    await send();
    await waitFor(() => expect(onMetrics).toHaveBeenCalledTimes(1));
    expect(onMetrics.mock.calls[0][0].ttftMs).toBe(5000);
    expect(onMetrics.mock.calls[0][0].firstEventMs).toBe(20);
    expect(onMetrics.mock.calls[0][0].firstTextMs).toBe(5000);
  });
  it("warns when reasoning consumes the explicit limit before an answer, without retry", async () => {
    const f = installStream(event({ choices: [{ delta: { reasoning_content: "thinking only" } }] }) + event({ choices: [{ delta: {}, finish_reason: "length" }] }) + "data: [DONE]\n\n", 9);
    render(<ChatTab configState={{ ...config, params: { ...config.params, max_tokens: 768 } }} />);
    await send();
    expect(screen.getByText("reasoningLimitReached")).toBeTruthy();
    expect(f).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ max_tokens: 768 });
  });
  it("sends the displayed default token limit explicitly and requests provider usage", async () => {
    const f = installStream(event({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n", 1000);
    render(<ChatTab configState={config} />);
    await send();
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ max_tokens: 1024, stream_options: { include_usage: true } });
  });
  it("Clear during a stream aborts it and never repopulates the cleared chat", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(event({ choices: [{ delta: { content: "Частичный" } }] }))); },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { headers: { "Content-Type": "text/event-stream" } })));
    render(<ChatTab configState={config} />);
    await send();
    await waitFor(() => expect(screen.getByText("Частичный")).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByTitle("clearChat")); });
    expect(cancelled).toBe(true);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText("Частичный")).toBeNull();
  });
});
