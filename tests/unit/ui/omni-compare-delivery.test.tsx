// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatTab from "../../../src/app/(dashboard)/dashboard/playground/components/tabs/ChatTab";
import CompareTab from "../../../src/app/(dashboard)/dashboard/playground/components/tabs/CompareTab";
import { DEFAULT_PARAMS } from "../../../src/app/(dashboard)/dashboard/playground/components/ParamSliders";
import type { ConfigState } from "../../../src/app/(dashboard)/dashboard/playground/components/StudioConfigPane";
vi.mock("react-markdown", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("remark-gfm", () => ({ default: () => {} }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
Element.prototype.scrollIntoView = vi.fn();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const enc = new TextEncoder();
const event = (j: unknown) => `data: ${JSON.stringify(j)}\r\n\r\n`;
const config: ConfigState = {
  endpoint: "chat.completions", baseUrl: "", model: "test/one", systemPrompt: "Exact system instructions",
  params: { ...DEFAULT_PARAMS, effort: "high", thinking: true, seed: 42, stop: "STOP", jsonMode: true, max_tokens: 768, temperature: 0.3 },
  reasoning: { show: true, effortOptions: ["low", "high"] },
};
function network(payload = event({ choices: [{ delta: { content: "Ответ 🌿" } }] }) + event({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 3 } }) + "data: [DONE]\r\n\r\n") {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    if (!init?.method) return Response.json({ data: ["test/one", "test/two"].map(id => ({ id, capabilities: { supportsThinking: true, effort_tiers: ["low", "high"] } })) });
    const bytes = enc.encode(payload);
    return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 1) c.enqueue(bytes.slice(i, i + 1)); c.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", f);
  return f;
}
async function run() {
  fireEvent.change(screen.getByRole("textbox", { name: "userPrompt" }), { target: { value: "same synthetic prompt" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "runAllColumns" })); });
}
it("Compare sends the same model, system, effort, limits and JSON fields as Chat", async () => {
  const f = network();
  const chat = render(<ChatTab configState={config} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "same synthetic prompt" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /send/i })); });
  const chatPost = f.mock.calls.find(([, init]) => init?.method === "POST")!;
  chat.unmount(); f.mockClear();
  render(<CompareTab configState={config} />);
  await act(async () => {});
  await run();
  const comparePost = f.mock.calls.find(([, init]) => init?.method === "POST")!;
  const body = JSON.parse(comparePost[1]!.body as string);
  expect(body).toEqual(JSON.parse(chatPost[1]!.body as string));
  expect(body).toMatchObject({ model: "test/one", effort: "high", thinking: true, max_tokens: 768, seed: 42, stop: "STOP", response_format: { type: "json_object" } });
  expect(comparePost[0]).toBe("/api/v1/chat/completions");
});
it("blocks Compare while per-model reasoning capabilities are unconfirmed instead of stripping effort", async () => {
  const f = network();
  f.mockImplementation(async (_url, init) => init?.method ? new Response("data: [DONE]\n\n") : Response.json({ data: [{ id: "test/one" }] }));
  render(<CompareTab configState={config} />);
  await act(async () => {});
  await run();
  expect(f.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  expect(screen.getByText(/modelParametersUnconfirmed/)).toBeTruthy();
});
it("Compare retains full partial UTF-8 output and reports an in-stream error", async () => {
  const f = network(event({ choices: [{ delta: { content: "Частичный 🌿" } }] }) + event({ error: { message: "compare synthetic failure" } }) + "data: [DONE]\n\n");
  render(<CompareTab configState={config} />);
  await act(async () => {}); await run();
  expect(screen.getByText("compare synthetic failure", { exact: false, selector: "div.text-destructive" })).toBeTruthy();
  expect(screen.getByText("Частичный 🌿", { exact: true })).toBeTruthy();
  expect(f.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
