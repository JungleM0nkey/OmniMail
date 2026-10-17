import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const origin = 'http://127.0.0.1:8942';
const mailOrigin = 'https://mail.apehost.dev';
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ locale: 'en-US' });
  // Keep the real response headers while avoiding Chromium's localhost frame restrictions.
  await context.route(`${mailOrigin}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const upstream = await fetch(`${origin}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: { ...request.headers(), Origin: origin },
      ...(request.postDataBuffer() ? { body: request.postDataBuffer() } : {}),
    });
    await route.fulfill({ status: upstream.status, headers: Object.fromEntries(upstream.headers),
      body: Buffer.from(await upstream.arrayBuffer()) });
  });
  const response = await context.request.get(origin);
  assert.equal(response.status(), 200);
  const headers = response.headers();
  assert.ok(headers['content-security-policy'].includes("frame-ancestors 'self' https://console.apehost.dev"));
  assert.equal(headers['x-frame-options'], undefined);
  assert.equal((await context.request.get(`${origin}/api/messages`)).status(), 401);
  const page = await context.newPage();
  const diagnostics = [];
  page.on('console', message => diagnostics.push(message.text()));
  page.on('pageerror', error => diagnostics.push(error.message));
  for (const parent of ['https://console.apehost.dev', 'https://untrusted.example']) {
    await page.route(`${parent}/**`, route => route.fulfill({
      contentType: 'text/html',
      body: `<iframe id="mail" src="${mailOrigin}" style="width:98vw;height:95vh"></iframe>`,
    }));
  }
  await page.goto('https://console.apehost.dev/omnimail-smoke');
  try {
    await page.frameLocator('#mail').getByText('OmniMail', { exact: true }).first().waitFor({ timeout: 10000 });
  } catch (error) {
    await page.screenshot({ path: '.wrangler/omnimail-browser-failure.png' });
    console.log(JSON.stringify({ frames: page.frames().map(frame => frame.url()), diagnostics }));
    throw error;
  }
  await page.screenshot({ path: '.wrangler/omnimail-console.png' });
  const blocked = page.waitForEvent('console', {
    predicate: message => message.text().includes('frame-ancestors'), timeout: 10000,
  });
  await page.goto('https://untrusted.example/omnimail-smoke');
  await blocked;
  assert.equal(await page.frameLocator('#mail').getByText('OmniMail', { exact: true }).count(), 0);
  const setup = { displayName: 'Local smoke', password: 'Local-only-password-12345' };
  const config = await (await context.request.get(`${origin}/api/config`)).json();
  if (!config.setupComplete) {
    assert.equal((await context.request.post(`${origin}/api/setup`, {
    headers: { Origin: origin }, data: { ...setup, setupToken: 'wrong-token' },
  })).status(), 403);
  assert.equal((await context.request.post(`${origin}/api/setup`, {
    headers: { Origin: origin },
    data: { ...setup, setupToken: 'local-smoke-only-setup-token-at-least-32-bytes' },
    })).status(), 201);
  }
  await page.goto(mailOrigin);
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  await page.locator('form input[type=email]').fill('m0nkey@apehost.dev');
  await page.locator('form input[type=password]').fill(setup.password);
  await page.locator('form button[type=submit]').click();
  await page.waitForFunction(async () => {
    const response = await fetch('/api/session');
    return (await response.json()).user?.email === 'm0nkey@apehost.dev';
  });
  assert.equal((await context.request.post(`${origin}/api/setup`, {
    headers: { Origin: origin }, data: setup,
  })).status(), 409);
  assert.equal((await context.request.post(`${origin}/api/logout`, {
    headers: { Origin: 'https://untrusted.example' }, data: {},
  })).status(), 403);
  console.log('OmniMail local Worker smoke passed: console-only embedding, blocked untrusted frame, anonymous inbox denial, browser sign-in, closed setup, CSRF.');
} finally { await browser.close(); }
