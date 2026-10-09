import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/tailscale-subscriptions.mjs');
const hostname = 'proxy.test.ts.net';

function mapping(target, port = 443) {
  return {
    TCP: { [port]: { HTTPS: true } },
    Web: { [`${hostname}:${port}`]: { Handlers: { '/': { Proxy: target } } } },
  };
}

async function harness(run) {
  const directory = await mkdtemp(join(tmpdir(), 'subscription-tailscale-test-'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html><title>Subscription Desk</title></html>');
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const backendPort = server.address().port;
  const target = `http://127.0.0.1:${backendPort}`;
  const config = join(directory, 'config.yaml');
  const stateFile = join(directory, 'state.json');
  const executable = join(directory, 'tailscale');
  await writeFile(config, `config-version: 8
server: {host: '127.0.0.1', port: ${backendPort}}
management: {secret-key: 'test-management-key', allow-remote: false, disable-control-panel: false}
access: {api-keys: ['test-client-key']}
`);
  await writeFile(stateFile, JSON.stringify({ node: { BackendState: 'Running', Self: { DNSName: `${hostname}.` } }, serve: {}, calls: [] }));
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.MOCK_TAILSCALE_STATE, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
if (args[0] === 'status') console.log(JSON.stringify(state.node));
else if (args[1] === 'status') console.log(JSON.stringify(state.serve));
else {
  const port = Number(args.find(arg => arg.startsWith('--https=')).split('=')[1]);
  const host = state.node.Self.DNSName.replace(/[.]$/, '') + ':' + port;
  if (args.includes('off')) {
    delete state.serve.TCP?.[port];
    delete state.serve.Web?.[host];
  } else {
    state.serve.TCP ||= {};
    state.serve.Web ||= {};
    state.serve.TCP[port] = { HTTPS: true };
    state.serve.Web[host] = { Handlers: { '/': { Proxy: args.at(-1) } } };
  }
}
fs.writeFileSync(process.env.MOCK_TAILSCALE_STATE, JSON.stringify(state));
`, { mode: 0o700 });
  const readState = async () => JSON.parse(await readFile(stateFile, 'utf8'));
  const update = async changes => writeFile(stateFile, JSON.stringify({ ...await readState(), ...changes }));
  const invoke = async (...args) => new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: directory, env: { ...process.env, TAILSCALE_BIN: executable, MOCK_TAILSCALE_STATE: stateFile }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('exit', code => resolveChild({ code, stdout, stderr }));
  });
  try { await run({ config, target, backendPort, invoke, readState, update }); }
  finally {
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  }
}

const mutations = state => state.calls.filter(args => args[0] === 'serve' && args[1] !== 'status');

test('Tailscale status needs no proxy config and logged-out enable does not mutate Serve', async () => {
  await harness(async ({ invoke, update, readState, config }) => {
    await update({ node: { BackendState: 'NeedsLogin' } });
    const status = await invoke('status', '--config', '/does-not-exist/config.yaml');
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).backendState, 'NeedsLogin');
    const enable = await invoke('enable', '--config', config);
    assert.equal(enable.code, 1);
    assert.match(enable.stderr, /sign(?:ed)?[ -]?in|login|logged|running/i);
    assert.deepEqual(mutations(await readState()), []);
  });
});

test('Tailscale enable adds private HTTPS only and preserves other Serve ports', async () => {
  await harness(async ({ invoke, update, readState, config, target }) => {
    const unrelated = mapping('http://127.0.0.1:9999', 8443);
    await update({ serve: unrelated });
    const result = await invoke('enable', '--config', config);
    assert.equal(result.code, 0, result.stderr);
    const state = await readState();
    assert.deepEqual(mutations(state), [['serve', '--bg', '--https=443', '--yes', target]]);
    assert.deepEqual(state.serve.Web[`${hostname}:8443`], unrelated.Web[`${hostname}:8443`]);
    assert.equal(state.serve.Web[`${hostname}:443`].Handlers['/'].Proxy, target);
    assert.equal(state.serve.AllowFunnel?.[`${hostname}:443`], undefined);
    assert.ok(!state.calls.some(args => args.includes('funnel') || args.includes('reset')));
    const status = JSON.parse((await invoke('status')).stdout);
    assert.equal(status.dashboardURL, `https://${hostname}/subscriptions/`);
    assert.equal(status.clientBaseURL, `https://${hostname}/v1`);
  });
});

test('Tailscale refuses an existing conflicting root, extra handler, or public Funnel', async () => {
  await harness(async ({ invoke, update, readState, config, target }) => {
    const conflicts = [
      mapping('http://127.0.0.1:9999'),
      { ...mapping(target), Web: { [`${hostname}:443`]: { Handlers: { '/': { Proxy: target }, '/other': { Proxy: 'http://127.0.0.1:9999' } } } } },
      { ...mapping(target), AllowFunnel: { [`${hostname}:443`]: true } },
      { Foreground: { session: mapping(target) } },
    ];
    for (const serve of conflicts) {
      await update({ serve, calls: [] });
      const result = await invoke('enable', '--config', config);
      assert.equal(result.code, 1, JSON.stringify(serve));
      assert.deepEqual(mutations(await readState()), [], result.stderr);
    }
  });
});

test('Tailscale enable is idempotent and disable removes only the owned mapping', async () => {
  await harness(async ({ invoke, update, readState, config, target }) => {
    const owned = mapping(target);
    const unrelated = mapping('http://127.0.0.1:9999', 8443);
    await update({ serve: { TCP: { ...owned.TCP, ...unrelated.TCP }, Web: { ...owned.Web, ...unrelated.Web } } });
    assert.equal((await invoke('enable', '--config', config)).code, 0);
    assert.deepEqual(mutations(await readState()), []);
    const disabled = await invoke('disable', '--config', config);
    assert.equal(disabled.code, 0, disabled.stderr);
    const state = await readState();
    assert.deepEqual(mutations(state), [['serve', '--https=443', 'off']]);
    assert.equal(state.serve.Web[`${hostname}:443`], undefined);
    assert.deepEqual(state.serve.Web[`${hostname}:8443`], unrelated.Web[`${hostname}:8443`]);
    await update({ serve: mapping('http://127.0.0.1:9999'), calls: [] });
    assert.equal((await invoke('disable', '--config', config)).code, 1);
    assert.deepEqual(mutations(await readState()), []);
  });
});

test('Tailscale rejects exposing a wildcard-bound proxy configuration', async () => {
  await harness(async ({ invoke, readState, config }) => {
    await writeFile(config, (await readFile(config, 'utf8')).replace("host: '127.0.0.1'", "host: '0.0.0.0'"));
    const result = await invoke('enable', '--config', config);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /loopback|127\.0\.0\.1/i);
    assert.deepEqual(mutations(await readState()), []);
  });
});

test('Tailscale accepts an explicit HTTPS port and rejects invalid ports before mutating', async () => {
  await harness(async ({ invoke, readState, config, target }) => {
    const enabled = await invoke('enable', '--config', config, '--https-port', '8443');
    assert.equal(enabled.code, 0, enabled.stderr);
    assert.deepEqual(mutations(await readState()), [['serve', '--bg', '--https=8443', '--yes', target]]);
    const previous = mutations(await readState());
    for (const port of ['0', '65536', 'abc']) {
      assert.equal((await invoke('enable', '--config', config, '--https-port', port)).code, 1);
      assert.deepEqual(mutations(await readState()), previous);
    }
  });
});

test('Tailscale validates effective v8 overrides in mixed legacy configurations', async () => {
  await harness(async ({ invoke, config, backendPort, readState }) => {
    await writeFile(config, `host: '0.0.0.0'
port: 9999
trusted-proxies: ['127.0.0.1']
api-keys: ['legacy-client-key']
remote-management: {secret-key: 'test-key', allow-remote: true}
server: {host: '127.0.0.1', port: ${backendPort}, trusted-proxies: []}
management: {allow-remote: false}
`);
    const enabled = await invoke('enable', '--config', config);
    assert.equal(enabled.code, 0, enabled.stderr);
    const previous = mutations(await readState());
    await writeFile(config, `${await readFile(config, 'utf8')}access: {api-keys: []}\n`);
    const refused = await invoke('enable', '--config', config);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /api-keys/i);
    assert.deepEqual(mutations(await readState()), previous);
  });
});

test('Tailscale rejects inherited remote management and legacy TLS settings', async () => {
  await harness(async ({ invoke, config, readState }) => {
    const original = await readFile(config, 'utf8');
    const inherited = original.replace(/management: .*\n/, `defaults: &defaults {allow-remote: true}
management: {<<: *defaults, secret-key: 'test-key'}
`);
    await writeFile(config, inherited);
    const refusedMerge = await invoke('enable', '--config', config);
    assert.equal(refusedMerge.code, 1);
    assert.match(refusedMerge.stderr, /allow-remote/i);
    await writeFile(config, original.replace(/server: .*\n/, line => `${line.trimEnd().slice(0, -1)}, tls: {cert: ''}}\n`) + 'tls: {enable: true}\n');
    const refusedTLS = await invoke('enable', '--config', config);
    assert.equal(refusedTLS.code, 1);
    assert.match(refusedTLS.stderr, /tls/i);
    assert.deepEqual(mutations(await readState()), []);
  });
});
