import { test, expect, type Page } from "@playwright/test";
import { gotoDashboardRoute } from "./helpers/dashboardAuth";

// Browser-level user-delivery checks against the isolated staging server.
// Upstream is mocked; nothing here writes provider/settings state on prod.
const event = (j: unknown) => `data: ${JSON.stringify(j)}\r\n\r\n`;
const sseHeaders = { "Content-Type": "text/event-stream" };

test.beforeEach(async ({ page, baseURL }) => {
  expect(baseURL, "refusing anything except the isolated staging server").toBe("http://127.0.0.1:20138");
  await page.route("**/api/playground/presets", (route) => route.fulfill({ json: { presets: [] } }));
  // Stage-safe guard: reads pass; only auth/onboarding/chat POSTs pass; other mutations are blocked.
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    const m = route.request().method();
    if (["GET", "HEAD", "OPTIONS"].includes(m)) return route.fallback();
    if (/\/api\/(auth|onboarding)/.test(url) || url.includes("/api/v1/chat/completions")) return route.fallback();
    return route.abort("blockedbyclient");
  });
});

async function openChat(page: Page) {
  await gotoDashboardRoute(page, "/dashboard/playground");
  const chatTab = page.getByRole("tab", { name: /chat/i });
  await expect(chatTab).toBeVisible({ timeout: 20000 });
  await chatTab.click();
  // Provide a model so the send path is enabled (upstream is mocked anyway).
  const modelInput = page.locator('input[placeholder*="gpt-4o"], input[placeholder*="Model" i]').first();
  if (await modelInput.isVisible().catch(() => false)) {
    await modelInput.fill("test/delivery");
  }
  const textbox = page.getByRole("textbox").first();
  await expect(textbox).toBeVisible({ timeout: 15000 });
  return textbox;
}

async function sendMessage(page: Page, textbox: ReturnType<Page["getByRole"]>) {
  await textbox.fill("synthetic check");
  await page.getByRole("button", { name: /send/i }).click();
}

test("chat renders multibyte UTF-8 content without corruption", async ({ page }) => {
  await page.route("**/api/v1/chat/completions", (route) =>
    route.fulfill({
      status: 200, headers: sseHeaders,
      body:
        event({ choices: [{ delta: { role: "assistant" } }] }) +
        event({ choices: [{ delta: { content: "Ответ 🌿 мир" } }] }) +
        event({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 0 } } }) +
        "data: [DONE]\r\n\r\n",
    }));
  const textbox = await openChat(page);
  await sendMessage(page, textbox);
  await expect(page.getByText("Ответ 🌿 мир")).toBeVisible({ timeout: 45000 });
});

test("chat keeps partial text and shows an in-stream error", async ({ page }) => {
  await page.route("**/api/v1/chat/completions", (route) =>
    route.fulfill({
      status: 200, headers: sseHeaders,
      body:
        event({ choices: [{ delta: { content: "Частичный ответ" } }] }) +
        event({ error: { message: "synthetic upstream failure", code: "upstream_error" } }) +
        "data: [DONE]\r\n\r\n",
    }));
  const textbox = await openChat(page);
  await sendMessage(page, textbox);
  await expect(page.getByText("Частичный ответ")).toBeVisible({ timeout: 45000 });
  await expect(page.getByText("synthetic upstream failure", { exact: true })).toBeVisible({ timeout: 15000 });
});

test("stop aborts an in-flight stream and the next request works", async ({ page }) => {
  let call = 0;
  await page.route("**/api/v1/chat/completions", async (route) => {
    call += 1;
    if (call === 1) {
      await new Promise((r) => setTimeout(r, 25000));
      await route.fulfill({
        status: 200, headers: sseHeaders,
        body: event({ choices: [{ delta: { content: "late-arrival" } }] }) + "data: [DONE]\r\n\r\n",
      }).catch(() => {});
      return;
    }
    await route.fulfill({
      status: 200, headers: sseHeaders,
      body: event({ choices: [{ delta: { content: "second ok" } }] }) + "data: [DONE]\r\n\r\n",
    });
  });
  const textbox = await openChat(page);
  await sendMessage(page, textbox);
  const stop = page.getByRole("button", { name: /stop/i });
  await expect(stop).toBeVisible({ timeout: 30000 });
  await stop.click();
  await expect(page.getByRole("button", { name: /send/i })).toBeVisible({ timeout: 30000 });
  await sendMessage(page, textbox);
  await expect(page.getByText("second ok")).toBeVisible({ timeout: 45000 });
});

test("playground stays inside the viewport at 390px (no horizontal overflow)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoDashboardRoute(page, "/dashboard/playground");
  await expect(page.getByRole("tab", { name: /chat/i })).toBeVisible({ timeout: 20000 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow, `horizontal overflow of ${overflow}px at 390px viewport`).toBeLessThanOrEqual(2);
});
