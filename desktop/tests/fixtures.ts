import { test as base, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export const test = base.extend<{ violations: string[] }, { controlsURL: string }>({
  controlsURL: [async ({}, use) => {
    const directory = resolve(root, 'dist');
    const config = JSON.parse(await readFile(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    await readFile(resolve(directory, 'index.html'));
    const server = createServer(async (request, response) => {
      const pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
      const file = resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(`${directory}${sep}`)) { response.writeHead(403).end(); return; }
      try {
        const content = await readFile(file);
        response.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream', 'content-security-policy': config.app.security.csp });
        response.end(content);
      } catch { response.writeHead(404).end(); }
    });
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Controls server did not bind');
    try { await use(`http://127.0.0.1:${address.port}`); }
    finally { await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); }
  }, { scope: 'worker' }],
  baseURL: async ({ controlsURL }, use) => { await use(controlsURL); },
  violations: [async ({ page }, use) => {
    const violations: string[] = [];
    page.on('console', message => {
      if (/content security policy|violates.*(?:script-src|style-src)/i.test(message.text())) violations.push(message.text());
    });
    await page.addInitScript(() => {
      const state = window as Window & { __cspViolations?: string[] };
      state.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', event => { state.__cspViolations!.push(`${event.violatedDirective}: ${event.blockedURI}`); });
    });
    await use(violations);
    violations.push(...await page.evaluate(() => (window as Window & { __cspViolations?: string[] }).__cspViolations || []));
    expect(violations, 'native controls must comply with the configured Tauri CSP').toEqual([]);
  }, { auto: true }],
});
export { expect };
