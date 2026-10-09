import { test as base, expect } from '@playwright/test';
import { startProxy, managementKey } from './start-proxy.mjs';

export const test = base.extend<{ cspErrors: string[] }, { proxyURL: string }>({
  proxyURL: [async ({}, use) => {
    const proxy = await startProxy();
    try { await use(proxy.url); } finally { await proxy.stop(); }
  }, { scope: 'worker' }],
  baseURL: async ({ proxyURL }, use) => { await use(proxyURL); },
  cspErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', message => {
      if (/content security policy|violates.*(?:script-src|style-src)/i.test(message.text())) errors.push(message.text());
    });
    await page.addInitScript(() => {
      const state = window as Window & { __cspViolations?: string[] };
      state.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', event => {
        state.__cspViolations!.push(`${event.violatedDirective}: ${event.blockedURI}`);
      });
    });
    await use(errors);
    errors.push(...await page.evaluate(() => (window as Window & { __cspViolations?: string[] }).__cspViolations || []));
    expect(errors, 'exported Next.js hydration must comply with the served CSP').toEqual([]);
  }, { auto: true }],
});
export { expect, managementKey };
