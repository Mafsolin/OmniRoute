import { test, expect, type Page } from "@playwright/test";

// Read-only browser checks: fixture API responses only, never provider/settings writes.
// The runner must point to the isolated staging server; it must arrange any staging
// login separately. This file never logs in or onboards any environment.
const fixtureName = "Staging first-paint fixture";
const connections = [{ id: "staging-fixture", provider: "openai-compatible-fixture", authType: "apikey", isActive: true }];
const nodes = [{ id: "openai-compatible-fixture", name: fixtureName, type: "openai-compatible" }];
async function fixtureReads(page: Page) {
  await page.route("**/api/providers", (route) => route.fulfill({ json: { connections } }));
  await page.route("**/api/provider-nodes", (route) => route.fulfill({ json: { nodes } }));
  await page.route("**/api/settings", (route) => route.fulfill({ json: { blockedProviders: [] } }));
  await page.route("**/api/providers/expiration", (route) => route.fulfill({ json: { list: [], summary: {} } }));
}

test.beforeEach(async ({ page, baseURL }) => {
  expect(baseURL, "refusing anything except the isolated staging server").toBe("http://127.0.0.1:20138");
  await page.route("**/api/**", (route) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method())) return route.abort("blockedbyclient");
    return route.fallback();
  });
});

test("provider cards are useful before delayed optional popularity stats", async ({ page }) => {
  await fixtureReads(page);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let optionalRequested = false;
  await page.route("**/api/providers/openrouter-stats", async (route) => {
    optionalRequested = true;
    await delayed;
    await route.fulfill({ json: { data: [] } }).catch(() => {});
  });
  try {
    await page.goto("/dashboard/providers?cat=compatible", { waitUntil: "domcontentloaded" });
    await expect(page.getByText(fixtureName, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Import from file|Импорт из файла/i })).toBeVisible();
    expect(optionalRequested).toBe(true);
  } finally { release(); }
});

test("unavailable settings policy leaves readable cards but disables mutations", async ({ page }) => {
  await fixtureReads(page);
  await page.route("**/api/settings", (route) => route.fulfill({ status: 503, json: { error: "Staging fixture: policy unavailable" } }));
  await page.route("**/api/providers/openrouter-stats", (route) => route.fulfill({ json: { data: [] } }));
  await page.goto("/dashboard/providers?cat=compatible", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(fixtureName, { exact: true })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: /policy|политик/i })).toContainText(/policy|политик/i);
  await expect(page.getByRole("button", { name: /Import from file|Импорт из файла/i })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Try Again|Повторить/i })).toBeEnabled();
});

test("401 provider reads show Retry instead of false empty onboarding", async ({ page }) => {
  await fixtureReads(page);
  let unavailable = true;
  await page.route("**/api/providers", (route) => route.fulfill(unavailable
    ? { status: 401, json: { error: "Staging fixture unauthorized" } }
    : { json: { connections } }));
  await page.route("**/api/providers/openrouter-stats", (route) => route.fulfill({ json: { data: [] } }));
  await page.goto("/dashboard/providers?cat=compatible", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("alert").filter({ hasText: "401" })).toContainText("401");
  await expect(page.getByText(/Add your first provider|Добавьте первого провайдера/i)).toHaveCount(0);
  unavailable = false;
  await page.getByRole("button", { name: /Try Again|Повторить/i }).click();
  await expect(page.getByText(fixtureName, { exact: true })).toBeVisible();
});
