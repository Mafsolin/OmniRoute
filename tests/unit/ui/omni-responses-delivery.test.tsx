// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatTab from "../../../src/app/(dashboard)/dashboard/playground/components/tabs/ChatTab";
import { DEFAULT_PARAMS } from "../../../src/app/(dashboard)/dashboard/playground/components/ParamSliders";
import type { ConfigState } from "../../../src/app/(dashboard)/dashboard/playground/components/StudioConfigPane";
vi.mock("react-markdown", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("remark-gfm", () => ({ default: () => {} }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
Element.prototype.scrollIntoView = vi.fn();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const config: ConfigState = {
  endpoint: "responses", baseUrl: "", model: "test/responses", systemPrompt: "Exact system instructions",
  params: { ...DEFAULT_PARAMS, effort: "high", max_tokens: 4096, temperature: 0.3, jsonMode: true },
  reasoning: { show: true, effortOptions: ["low", "high"] },
};
const frame = (type: string, fields: Record<string, unknown>) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`;
it("Responses sends native input, effort and output limit and displays fragmented text with completed usage", async () => {
  const payload = frame("response.created", { response: { id: "fixture" } }) +
    frame("response.output_text.delta", { item_id: "msg_1", delta: "Ответ 🌿" }) +
    frame("response.completed", { response: { status: "completed", output: [], usage: { input_tokens: 7, output_tokens: 11, output_tokens_details: { reasoning_tokens: 3 } } } });
  const bytes = new TextEncoder().encode(payload);
  const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(new ReadableStream({ start(c) {
    for (let i = 0; i < bytes.length; i++) c.enqueue(bytes.slice(i, i + 1)); c.close();
  } }), { headers: { "Content-Type": "text/event-stream" } }));
  vi.stubGlobal("fetch", f);
  const onMetrics = vi.fn();
  render(<ChatTab configState={config} onMetricsUpdate={onMetrics} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "synthetic context" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /send/i })); });
  expect(f.mock.calls[0][0]).toBe("/api/v1/responses");
  const body = JSON.parse(f.mock.calls[0][1]!.body as string);
  expect(body.input).toEqual([{ role: "system", content: "Exact system instructions" }, { role: "user", content: "synthetic context" }]);
  expect(body).toMatchObject({ model: "test/responses", stream: true, max_output_tokens: 4096, temperature: 0.3, reasoning: { effort: "high" }, text: { format: { type: "json_object" } } });
  expect(body).not.toHaveProperty("query"); expect(body).not.toHaveProperty("max_tokens");
  await waitFor(() => expect(screen.getByText("Ответ 🌿", { exact: true })).toBeTruthy());
  expect(onMetrics).toHaveBeenCalledTimes(1);
  expect(onMetrics.mock.calls[0][0]).toMatchObject({ tokensIn: 7, tokensOut: 11, reasoningTokens: 3 });
  fireEvent.click(screen.getByText("responseInspector"));
  expect(screen.getByTestId("chat-response-events").textContent).toContain("response.completed");
});
