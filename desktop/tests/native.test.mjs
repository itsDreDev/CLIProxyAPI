import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remoteOrigin, publicError } from '../src/native.ts';

test('shared host origins are normalized without carrying credentials or callback data', () => {
  assert.equal(remoteOrigin(' https://Proxy.Test.ts.net/ '), 'https://proxy.test.ts.net');
  assert.equal(remoteOrigin('https://proxy.test.ts.net:8443'), 'https://proxy.test.ts.net:8443');
  for (const value of ['http://127.0.0.1:8317', 'http://proxy.test.ts.net', 'https://proxy.test.ts.net.evil.test', 'https://user:password@proxy.test.ts.net', 'https://proxy.test.ts.net/subscriptions', 'https://proxy.test.ts.net?token=secret', 'https://proxy.test.ts.net#state', 'file:///etc/passwd', 'proxy.test.ts.net']) {
    assert.throws(() => remoteOrigin(value), /address|origin/i);
  }
});

test('native errors redact authentication and OAuth values before rendering or logging', () => {
  const message = publicError(new Error('Bearer private-bearer management_key=private-management access_token=private-access refresh_token=private-refresh https://callback.test/?code=private-code&state=private-state&token=private-token&key=private-key sk-abcdefghijklmnop'));
  for (const value of ['private-bearer', 'private-management', 'private-access', 'private-refresh', 'private-code', 'private-state', 'private-token', 'private-key', 'sk-abcdefghijklmnop']) assert.ok(!message.includes(value), value);
  assert.match(message, /hidden/);
  assert.equal(publicError({ unexpected: true }), 'The desktop operation could not be completed.');
});
