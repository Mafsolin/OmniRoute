import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
const out = '/opt/omniroute-quality-speed-data/browser-baseline';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  headless: true, args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const results = [];
try {
  for (const path of ['/login', '/dashboard/providers', '/dashboard/playground']) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message).slice(0, 300)));
    const start = performance.now();
    try {
      const response = await page.goto(`https://api.mafsolin.space${path}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const isLogin = new URL(page.url()).pathname === '/login';
      if (isLogin) await page.locator('input[type=password]').waitFor({ timeout: 10000 });
      const artifact = `${out}/${path.replaceAll('/', '_')}.png`;
      await page.screenshot({ path: artifact });
      results.push({ path, status: response?.status(), finalPath: new URL(page.url()).pathname,
        elapsedToRequiredControlMs: Math.round(performance.now() - start), isLogin,
        errors, screenshot: artifact,
        overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) });
    } catch (e) {
      results.push({ path, error: e.name, message: String(e.message).slice(0, 200), elapsedMs: Math.round(performance.now() - start), errors });
    }
    await page.close();
  }
  const page = await context.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('https://api.mafsolin.space/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.locator('input[type=password]').waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${out}/login-mobile.png` });
  results.push({ path: '/login', viewport: 390, overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), screenshot: `${out}/login-mobile.png` });
} finally {
  writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
console.log(JSON.stringify(results));
