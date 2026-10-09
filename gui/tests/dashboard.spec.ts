import type { Page, BrowserContext } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect, managementKey } from './fixtures';

async function captureScreenshot(page: Page, name: string) {
  const directory = process.env.SUBSCRIPTION_GUI_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, name), fullPage: true });
}

async function unlock(page: Page, key = managementKey) {
  await page.goto('/subscriptions/');
  await expect(page.locator('#unlock-dialog')).toBeVisible();
  await page.locator('#management-key').fill(key);
  await page.locator('#unlock-form button[type="submit"]').click();
  await expect(page.locator('#unlock-dialog')).toBeHidden();
}

function exampleAccounts() {
  return [
    { name: 'codex-personal.json', provider: 'codex', email: 'personal@example.com', status: 'active', auth_index: 'c1', success: 384, failed: 4, last_refresh: '2026-10-09T20:00:00Z', id_token: { plan_type: 'plus' } },
    { name: 'claude-work.json', provider: 'claude', email: 'work@example.com', status: 'active', auth_index: 'c2', success: 212, failed: 1, last_refresh: '2026-10-09T19:00:00Z' },
    { name: 'claude-personal.json', provider: 'claude', email: 'personal@example.com', status: 'disabled', disabled: true, auth_index: 'c3', success: 48, failed: 0 },
  ];
}

async function mockProviders(context: BrowserContext) {
  const state = {
    accounts: exampleAccounts(),
    failed: false,
    unauthorized: false,
    oauthStatus: 'wait',
    calls: [] as { path: string; method: string; body: string | null }[],
    accountReads: 0,
  };
  await context.route('**/v8/management/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/v8/management', '');
    const body = request.postData();
    state.calls.push({ path, method: request.method(), body });
    expect(request.headers().authorization).toBe('Bearer test-key');
    let result: unknown = {};
    let status = 200;
    if (state.unauthorized) { status = 401; result = { error: 'management key revoked' }; }
    else if (path === '/credentials' && request.method() === 'GET') {
      state.accountReads++;
      status = state.failed ? 503 : 200;
      result = state.failed ? { error: 'test provider outage' } : { files: state.accounts };
    } else if (path === '/credentials/status') {
      const data = JSON.parse(body!);
      const account = state.accounts.find(value => value.auth_index === data.auth_index)!;
      account.disabled = data.disabled;
      account.status = data.disabled ? 'disabled' : 'active';
    } else if (path === '/credentials/models') result = { models: [{ id: 'example-model' }] };
    else if (path === '/credentials' && request.method() === 'DELETE') state.accounts = state.accounts.filter(value => value.name !== url.searchParams.get('name'));
    else if (path === '/oauth/auth-url') { result = { state: 'qa-state', url: 'https://example.com/authorize' }; state.oauthStatus = 'wait'; }
    else if (path === '/oauth/status') result = { status: state.oauthStatus };
    else if (path === '/oauth/callback') { expect(JSON.parse(body!).code).toBe('qa-code'); state.oauthStatus = 'ok'; }
    else if (path === '/config') result = { routing: { strategy: 'round-robin' }, access: { 'api-keys': ['fake-client-key'] } };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await context.route('https://example.com/**', route => route.fulfill({ body: '<p>Simulated provider sign-in</p>', contentType: 'text/html' }));
  return state;
}

test('real Go APIs unlock, persist routing and client keys, and clear private state on lock', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await unlock(page);
  await expect(page.locator('#stat-total')).toHaveText('0');
  await page.locator('[data-page="settings"]').click();
  await expect(page.locator('#client-keys [data-copy-key]')).toHaveCount(1);
  await page.locator('#routing-strategy').selectOption('fill-first');
  await page.locator('#routing-form button[type="submit"]').click();
  await expect(page.getByText('Routing strategy saved.', { exact: true })).toBeVisible();
  const headers = { Authorization: `Bearer ${managementKey}` };
  expect(await (await request.get('/v8/management/config/routing/strategy', { headers })).json()).toBe('fill-first');
  await page.locator('#generate-key').click();
  await expect(page.locator('#client-keys [data-copy-key]')).toHaveCount(2);
  const config = await (await request.get('/v8/management/config', { headers })).json();
  expect(config.access['api-keys']).toHaveLength(2);
  expect(config.access['api-keys'][1]).toMatch(/^sk-local-[a-f0-9]+$/);
  await page.locator('#lock-button').click();
  await expect(page.locator('#unlock-dialog')).toBeVisible();
  await expect(page.locator('#client-keys [data-copy-key]')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  await page.reload();
  await expect(page.locator('#unlock-dialog')).toBeVisible();
  await page.locator('#management-key').fill(managementKey);
  await page.locator('#unlock-form button[type="submit"]').click();
  await expect(page.locator('#unlock-dialog')).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.locator('#unlock-dialog')).toBeVisible();
  await expect(page.locator('#client-keys [data-copy-key]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('account filters, pause, models, disconnect, OAuth validation, cancel and import', async ({ page, context }) => {
  const state = await mockProviders(context);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await unlock(page, 'test-key');
  await expect(page.locator('#stat-total')).toHaveText('3');
  await expect(page.locator('#stat-active')).toHaveText('2');
  await captureScreenshot(page, 'next-desktop.png');
  await page.locator('[data-filter="claude"]').click();
  await expect(page.locator('#account-rows tr')).toHaveCount(2);
  await page.locator('#account-search').fill('work@');
  await expect(page.locator('#account-rows tr')).toHaveCount(1);
  await page.locator('#account-rows [data-action="toggle"]').click();
  await expect(page.getByText('Account paused.', { exact: true })).toBeVisible();
  await expect(page.locator('#account-rows .badge')).toHaveText('Paused');
  await page.locator('#account-rows [data-action="details"]').click();
  await expect(page.locator('.model-list code')).toHaveText('example-model');
  await page.locator('#refresh-credential').click();
  await expect(page.getByText('Account credentials refreshed.', { exact: true })).toBeVisible();
  expect(state.calls.some(call => call.path === '/credentials/refresh' && JSON.parse(call.body!).auth_index === 'c2')).toBe(true);
  await page.locator('#account-rows [data-action="details"]').click();
  await expect(page.locator('.model-list code')).toHaveText('example-model');
  await page.locator('#remove-credential').click();
  await page.locator('#remove-form button[type="submit"]').click();
  await expect(page.getByText('Account disconnected.', { exact: true })).toBeVisible();
  expect(state.accounts).toHaveLength(2);
  await page.locator('#account-search').fill('');
  await page.locator('[data-filter="all"]').click();
  await page.locator('[data-connect="claude"]').first().click();
  await expect(page.locator('#oauth-dialog')).toBeVisible();
  await page.locator('#callback-input').fill('qa-code#other-state');
  await page.locator('#callback-form button[type="submit"]').click();
  await expect(page.locator('#oauth-dialog')).toBeVisible();
  expect(state.calls.filter(call => call.path === '/oauth/callback')).toHaveLength(0);
  await page.locator('#callback-input').fill('qa-code#qa-state');
  await page.locator('#callback-form button[type="submit"]').click();
  await expect(page.locator('#oauth-dialog')).toBeHidden();
  await page.locator('[data-connect="codex"]').first().click();
  await expect(page.locator('#oauth-dialog')).toBeVisible();
  await page.locator('#cancel-oauth').click();
  await expect(page.locator('#oauth-dialog')).toBeHidden();
  expect(state.calls.some(call => call.path === '/oauth/session' && call.method === 'DELETE')).toBe(true);
  await page.locator('#import-file').setInputFiles({ name: 'account.json', mimeType: 'application/json', buffer: Buffer.from('{"type":"codex","access_token":"test-only-token"}') });
  await expect(page.getByText('Account credential imported.', { exact: true })).toBeVisible();
  expect(state.calls.some(call => call.path === '/credentials' && call.method === 'POST' && call.body?.includes('codex-import-'))).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, 'next-mobile.png');
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('body *')].filter(element => element.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 12).map(element => ({ tag: element.tagName, id: element.id, class: element.className, right: element.getBoundingClientRect().right })),
  }));
  expect(dimensions.scrollWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.width);
  await page.locator('#lock-button').click();
  await expect(page.locator('#unlock-dialog')).toBeVisible();
  await expect(page.locator('#account-rows tr')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('live polling and focus refresh account data, preserve last snapshot during outages, and revoke on 401', async ({ page, context }) => {
  const state = await mockProviders(context);
  await unlock(page, 'test-key');
  await expect(page.locator('#stat-total')).toHaveText('3');
  state.accounts.pop();
  await expect(page.locator('#stat-total')).toHaveText('2', { timeout: 10000 });
  const reads = state.accountReads;
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => state.accountReads, { timeout: 2000 }).toBeGreaterThan(reads);
  state.failed = true;
  await page.locator('#refresh-list').click();
  await expect(page.locator('#stale-notice')).toBeVisible();
  await expect(page.locator('#stale-notice')).toContainText('test provider outage');
  await expect(page.locator('#stat-total')).toHaveText('2');
  state.failed = false;
  await page.locator('#refresh-list').click();
  await expect(page.locator('#stale-notice')).toBeHidden();
  state.unauthorized = true;
  await page.locator('#refresh-list').click();
  await expect(page.locator('#unlock-dialog')).toBeVisible();
  await expect(page.locator('#account-rows tr')).toHaveCount(0);
});

test('hidden tabs suspend polling and becoming visible revalidates immediately', async ({ page, context }) => {
  const state = await mockProviders(context);
  await page.clock.install();
  await unlock(page, 'test-key');
  await expect(page.locator('#stat-total')).toHaveText('3');
  await expect(page.locator('#refresh-list')).toBeEnabled();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const reads = state.accountReads;
  state.accounts.pop();
  await page.clock.runFor(10000);
  expect(state.accountReads).toBe(reads);
  await expect(page.locator('#stat-total')).toHaveText('3');
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'visibilityState');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#stat-total')).toHaveText('2');
  expect(state.accountReads).toBeGreaterThan(reads);
});
