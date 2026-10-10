import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

interface NativeStatus {
  running: boolean;
  owned: boolean;
  mode: 'local' | 'remote';
  dashboard_url: string;
  endpoint: string;
  config_path: string;
  error?: string;
}
interface NativeMock {
  status: NativeStatus;
  calls: { command: string; args?: Record<string, unknown> }[];
  failures: Record<string, string>;
  clipboard: string;
  pauseStatus: boolean;
  completeStatus?: () => void;
  callbacks: Record<number, (event: unknown) => void>;
  listeners: Record<number, { event: string; handler: number }>;
}
type MockWindow = Window & { isTauri: boolean; __TAURI_INTERNALS__: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown>; transformCallback(callback: (event: unknown) => void): number }; __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener(event: string, id: number): void }; __desktopMock: NativeMock };
const localStatus: NativeStatus = { running: false, owned: false, mode: 'local', dashboard_url: 'http://127.0.0.1:8317/subscriptions/', endpoint: 'http://127.0.0.1:8317/v1', config_path: '/native/test-profile/config.yaml' };
const managementKey = 'native-test-only-management-key';

async function nativeMock(page: Page, status: NativeStatus = localStatus) {
  await page.addInitScript(({ initial, secret }) => {
    const native = window as unknown as MockWindow;
    const state: NativeMock = { status: initial, calls: [], failures: {}, clipboard: '', pauseStatus: false, callbacks: {}, listeners: {} };
    let callbackId = 0;
    native.__desktopMock = state;
    native.isTauri = true;
    native.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => { delete state.listeners[id]; } };
    native.__TAURI_INTERNALS__ = {
      transformCallback: callback => { state.callbacks[++callbackId] = callback; return callbackId; },
      invoke: async (command, args) => {
        state.calls.push({ command, args });
        if (state.failures[command]) throw new Error(state.failures[command]);
        if (command === 'plugin:event|listen') { const id = Number(args!.handler); state.listeners[id] = { event: String(args!.event), handler: id }; return id; }
        if (command === 'plugin:event|unlisten') return;
        if (command === 'get_status' && state.pauseStatus) {
          const snapshot = { ...state.status };
          return new Promise(resolveStatus => { state.completeStatus = () => { state.pauseStatus = false; resolveStatus(snapshot); }; });
        }
        if (command === 'copy_management_key') { state.clipboard = secret; return; }
        if (command === 'start_proxy') state.status = { ...state.status, running: true, owned: true };
        else if (command === 'stop_proxy') state.status = { ...state.status, running: false, owned: false };
        else if (command === 'use_local') state.status = { ...initial, running: false, owned: false };
        else if (command === 'connect_remote') {
          const origin = new URL(String(args?.origin)).origin;
          state.status = { ...state.status, running: false, owned: false, mode: 'remote', dashboard_url: `${origin}/subscriptions/`, endpoint: `${origin}/v1` };
        } else if (command === 'open_dashboard') return;
        else if (command !== 'get_status') throw new Error(`Unexpected native command: ${command}`);
        return { ...state.status };
      },
    };
  }, { initial: status, secret: managementKey });
}

async function nativeCalls(page: Page, command: string) {
  return page.evaluate(name => (window as unknown as MockWindow).__desktopMock.calls.filter(call => call.command === name), command);
}

test('desktop controls require a native IPC context', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#desktop-required')).toBeVisible();
  await expect(page.locator('#start-proxy')).toBeDisabled();
});

test('owned local proxy starts and stops, and opens the dashboard without navigating controls', async ({ page }) => {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('#proxy-status')).toContainText(/stopped/i);
  await expect(page.locator('#proxy-endpoint')).toHaveText(localStatus.endpoint);
  await page.locator('#start-proxy').click();
  await expect(page.locator('#proxy-status')).toContainText(/running/i);
  await expect(page.locator('#stop-proxy')).toBeEnabled();
  const controlsURL = page.url();
  await page.locator('#open-dashboard').click();
  expect(await nativeCalls(page, 'open_dashboard')).toHaveLength(1);
  expect(page.url()).toBe(controlsURL);
  await page.locator('#stop-proxy').click();
  await expect(page.locator('#proxy-status')).toContainText(/stopped/i);
  expect(await nativeCalls(page, 'start_proxy')).toHaveLength(1);
  expect(await nativeCalls(page, 'stop_proxy')).toHaveLength(1);
});

test('shared host selection disables local controls and returns to the local profile', async ({ page }) => {
  await nativeMock(page);
  await page.goto('/');
  await page.locator('#connect-shared').click();
  await page.locator('#remote-origin').fill('https://proxy.test.ts.net');
  await page.locator('#remote-form button[type="submit"]').click();
  await expect(page.locator('#proxy-status')).toContainText(/shared host selected/i);
  await expect(page.locator('#proxy-endpoint')).toHaveText('https://proxy.test.ts.net/v1');
  await expect(page.locator('#start-proxy')).toHaveCount(0);
  await expect(page.locator('#stop-proxy')).toHaveCount(0);
  await expect(page.locator('#copy-management-key')).toHaveCount(0);
  expect((await nativeCalls(page, 'connect_remote'))[0].args).toEqual({ origin: 'https://proxy.test.ts.net' });
  await page.locator('#open-dashboard').click();
  expect(await nativeCalls(page, 'get_management_key')).toHaveLength(0);
  await page.locator('#host-local').click();
  await expect(page.locator('#proxy-endpoint')).toHaveText(localStatus.endpoint);
  await expect(page.locator('#start-proxy')).toBeEnabled();
  expect(await nativeCalls(page, 'use_local')).toHaveLength(1);
});

test('native operation errors stay visible without claiming the proxy is running', async ({ page }) => {
  await page.clock.install();
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('#start-proxy')).toBeEnabled();
  await page.evaluate(() => { (window as unknown as MockWindow).__desktopMock.failures.start_proxy = 'The local port is already occupied.'; });
  await page.locator('#start-proxy').click();
  await expect(page.locator('#desktop-error')).toContainText('The local port is already occupied.');
  await expect(page.locator('#proxy-status')).toContainText(/stopped/i);
  await expect(page.locator('#start-proxy')).toBeEnabled();
  await page.clock.runFor(2500);
  await expect(page.locator('#desktop-error')).toContainText('The local port is already occupied.');
});

test('management key copying does not render, log or persist the secret in browser storage', async ({ page }) => {
  await nativeMock(page);
  const messages: string[] = [];
  page.on('console', message => messages.push(message.text()));
  await page.goto('/');
  await expect(page.locator('#copy-management-key')).toBeEnabled();
  await page.locator('#copy-management-key').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as MockWindow).__desktopMock.clipboard)).toBe(managementKey);
  expect(await page.content()).not.toContain(managementKey);
  expect(messages.join('\n')).not.toContain(managementKey);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  expect(await nativeCalls(page, 'copy_management_key')).toHaveLength(1);
  expect(await nativeCalls(page, 'get_management_key')).toHaveLength(0);
});

test('a proxy started outside the app can be opened but cannot be stopped by its controls', async ({ page }) => {
  await nativeMock(page, { ...localStatus, running: true, owned: false });
  await page.goto('/');
  await expect(page.locator('#proxy-status')).toContainText(/running/i);
  await expect(page.locator('#start-proxy')).toBeDisabled();
  await expect(page.locator('#stop-proxy')).toBeDisabled();
  await expect(page.locator('#open-dashboard')).toBeEnabled();
  await expect(page.locator('#copy-management-key')).toBeDisabled();
  expect(await nativeCalls(page, 'stop_proxy')).toHaveLength(0);
});

test('a delayed status poll cannot overwrite a completed proxy start', async ({ page }) => {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('#proxy-status')).toContainText(/stopped/i);
  await page.evaluate(() => {
    (window as unknown as MockWindow).__desktopMock.pauseStatus = true;
    window.dispatchEvent(new Event('focus'));
  });
  await expect.poll(() => page.evaluate(() => !!(window as unknown as MockWindow).__desktopMock.completeStatus)).toBe(true);
  await page.locator('#start-proxy').click();
  await expect(page.locator('#proxy-status')).toContainText(/running/i);
  await page.evaluate(async () => {
    (window as unknown as MockWindow).__desktopMock.completeStatus!();
    await new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())));
  });
  await expect(page.locator('#proxy-status')).toContainText(/running/i);
  await expect(page.locator('#stop-proxy')).toBeEnabled();
});

test('tray failures reach the controls and redact sensitive details', async ({ page }) => {
  await nativeMock(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Object.values((window as unknown as MockWindow).__desktopMock.listeners).filter(listener => listener.event === 'desktop-error').length)).toBe(1);
  await page.evaluate(() => {
    const state = (window as unknown as MockWindow).__desktopMock;
    for (const [id, listener] of Object.entries(state.listeners)) {
      if (listener.event === 'desktop-error') state.callbacks[listener.handler]({ event: 'desktop-error', id: Number(id), payload: 'Proxy launch failed. Bearer private-tray-secret' });
    }
  });
  await expect(page.locator('#desktop-error')).toContainText('Proxy launch failed. Bearer [hidden]');
  await expect(page.locator('#activity-log')).toContainText('Proxy launch failed. Bearer [hidden]');
  expect(await page.content()).not.toContain('private-tray-secret');
});
