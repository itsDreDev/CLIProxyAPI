import assert from 'node:assert/strict';
import { test } from 'node:test';
import { oauthConnectionMode } from '../lib/accounts.ts';

test('loopback dashboard and proxy origins enable the server callback listener', () => {
  for (const origin of ['http://localhost:8317', 'http://127.0.0.1:8317', 'http://127.0.0.2:8317', 'http://[::1]:8317']) {
    const mode = oauthConnectionMode(origin);
    assert.equal(mode.isWebUI, true, origin);
    assert.equal(mode.remote, false, origin);
    assert.equal(mode.tailscaleHTTPS, false, origin);
    assert.equal(mode.dashboardOrigin, new URL(origin).origin);
    assert.equal(mode.proxyOrigin, new URL(origin).origin);
  }
});

test('shared hosts use manual callbacks and identify private Tailscale HTTPS', () => {
  for (const origin of ['https://proxy.example.ts.net', 'https://proxy.example.test', 'http://100.64.0.10:8317', 'http://localhost.example.test:8317']) {
    const mode = oauthConnectionMode(origin);
    assert.equal(mode.isWebUI, false, origin);
    assert.equal(mode.remote, true, origin);
    assert.equal(mode.tailscaleHTTPS, origin === 'https://proxy.example.ts.net', origin);
  }
  assert.equal(oauthConnectionMode('http://proxy.example.ts.net').tailscaleHTTPS, false);
});

test('a local Next development page still uses manual callbacks for a shared proxy', () => {
  const mode = oauthConnectionMode('http://localhost:3000', 'https://proxy.example.ts.net');
  assert.deepEqual(mode, {
    dashboardOrigin: 'http://localhost:3000',
    proxyOrigin: 'https://proxy.example.ts.net',
    isWebUI: false,
    remote: true,
    tailscaleHTTPS: true,
  });
  assert.equal(oauthConnectionMode('http://localhost:3000', 'http://127.0.0.1:8317').isWebUI, true);
  assert.equal(oauthConnectionMode('https://proxy.example.ts.net', 'http://127.0.0.1:8317').isWebUI, false);
});
