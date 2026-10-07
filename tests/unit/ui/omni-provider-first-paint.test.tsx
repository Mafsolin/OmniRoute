// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ProvidersPage from "../../../src/app/(dashboard)/dashboard/providers/page";

// The shared VPS is CPU-contended; behavior checks use unresolved fixtures, not wall-clock SLAs.
vi.setConfig({ testTimeout: 20_000 });

const navigation = vi.hoisted(() => ({ push: vi.fn(), params: new URLSearchParams("cat=compatible") }));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  useSearchParams: () => navigation.params,
  usePathname: () => "/dashboard/providers",
}));
vi.mock("next/link", () => ({ default: ({ children, prefetch: _prefetch, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock("next/image", () => ({ default: ({ fill: _fill, priority: _priority, unoptimized: _unoptimized, ...props }: any) => <img {...props} /> }));
// Isolate file/credential modals, not the page, loaders, summary, or provider cards.
vi.mock("@/shared/components/ProviderIcon", () => ({ default: () => <span aria-hidden="true" /> }));
vi.mock("@/shared/components/ProviderTestSlideOver", () => ({ default: () => null }));
vi.mock("next/dynamic", () => ({ default: (loader: () => Promise<unknown>) => {
  if (String(loader).includes("ImportProvidersFromFileModal")) {
    return ({ isOpen, onImported }: any) => isOpen
      ? <button onClick={() => void onImported()}>Finish fixture import</button> : null;
  }
  return () => null;
} }));

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { "Content-Type": "application/json" },
});
const connections = [{ id: "fixture", provider: "openai-compatible-fixture", authType: "apikey", isActive: true }];
const nodes = [{ id: "openai-compatible-fixture", name: "Fixture compatible provider", type: "openai-compatible" }];
function installFetch(overrides: Record<string, () => Promise<Response>> = {}) {
  const mock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const key = String(url);
    if (overrides[key]) return overrides[key]();
    if (key === "/api/providers") return json({ connections });
    if (key === "/api/provider-nodes") return json({ nodes });
    if (key === "/api/settings") return json({ blockedProviders: [] });
    if (key === "/api/system/env/repair") return json({ available: true, missingCount: 1 });
    if (key === "/api/providers/expiration") return json({ list: [], summary: {} });
    if (key === "/api/providers/openrouter-stats") return json({ data: [] });
    return json({});
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
beforeEach(() => { localStorage.clear(); window.history.replaceState(null, "", "/dashboard/providers"); navigation.push.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("renders actual provider cards before optional stats finish", async () => {
  installFetch({ "/api/providers/openrouter-stats": () => new Promise(() => {}) });
  render(<ProvidersPage />);
  expect(await screen.findByText("Fixture compatible provider", {}, { timeout: 1500 })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Import from file/i })).toBeTruthy();
});

it("shows a provider 401 error, not first-provider onboarding, and Retry recovers", async () => {
  let failed = true;
  installFetch({ "/api/providers": async () => failed ? json({ error: "Unauthorized" }, 401) : json({ connections }) });
  render(<ProvidersPage />);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText(/Add your first provider/i)).toBeNull();
  expect(screen.getByText(/401/)).toBeTruthy();
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: /Try Again/i }));
  expect(await screen.findByText("Fixture compatible provider")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps cards readable but locks UI and mutation handlers when settings policy is unavailable", async () => {
  const fetchMock = installFetch({ "/api/settings": async () => json({ error: "policy unavailable" }, 503) });
  render(<ProvidersPage />);
  expect(await screen.findByText("Fixture compatible provider")).toBeTruthy();
  expect(await screen.findByRole("alert")).toBeTruthy();
  const importButton = screen.getByRole("button", { name: /Import from file/i });
  expect(importButton.matches(":disabled")).toBe(true);
  fireEvent.click(importButton);
  expect(screen.queryByText("Finish fixture import")).toBeNull();
  // Force the card's wrapper callback as well as the native disabled control:
  // handlers must reject unknown policy even when a synthetic event bypasses the UI.
  const toggle = screen.getByRole("switch");
  expect(toggle.matches(":disabled")).toBe(true);
  fireEvent.click(toggle.parentElement!);
  for (const button of screen.getAllByRole("button").filter((button) => /Test all/i.test(button.textContent ?? ""))) {
    expect(button.matches(":disabled")).toBe(true);
    fireEvent.click(button);
  }
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET")).toHaveLength(0);
});

it("refreshes imported connections through the core loader without waiting for optional stats", async () => {
  let reads = 0;
  installFetch({
    "/api/providers": async () => json({ connections: reads++ === 0 ? connections : connections.map((item) => ({ ...item, isActive: false })) }),
    "/api/providers/openrouter-stats": () => new Promise(() => {}),
  });
  render(<ProvidersPage />);
  expect(await screen.findByText("Fixture compatible provider")).toBeTruthy();
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: /Import from file/i }));
  fireEvent.click(screen.getByText("Finish fixture import"));
  await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"));
});

it("aborts both initial core and enrichment reads on unmount, even if fetch ignores cancellation", async () => {
  const urls = ["/api/providers", "/api/provider-nodes", "/api/settings", "/api/providers/expiration", "/api/providers/openrouter-stats"];
  const fetchMock = installFetch(Object.fromEntries(urls.map((url) => [url, () => new Promise<Response>(() => {})])));
  const view = render(<ProvidersPage />);
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => urls.includes(String(url)))).toHaveLength(5));
  const signals = fetchMock.mock.calls.filter(([url]) => urls.includes(String(url))).map(([, init]) => init?.signal);
  expect(signals.every((signal) => signal && !signal.aborted)).toBe(true);
  view.unmount();
  expect(signals.every((signal) => signal?.aborted)).toBe(true);
});

it("preserves known connections and shows refresh errors after import instead of clearing the cards", async () => {
  let reads = 0;
  installFetch({ "/api/providers": async () => reads++ === 0 ? json({ connections }) : json({ error: "fixture unavailable" }, 503) });
  render(<ProvidersPage />);
  expect(await screen.findByText("Fixture compatible provider")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Import from file/i }));
  fireEvent.click(screen.getByText("Finish fixture import"));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText("Fixture compatible provider")).toBeTruthy();
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByText(/Add your first provider/i)).toBeNull();
});
