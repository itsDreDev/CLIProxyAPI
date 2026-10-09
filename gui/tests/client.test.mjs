import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient, ManagementError, retryManagementQuery } from "../lib/client.ts";
import { accountStatus, callbackPayload, subscriptionAccounts, totals } from "../lib/accounts.ts";

test("only subscription accounts contribute to status and usage", () => {
  const accounts = subscriptionAccounts([
    { provider: "codex", success: 8, failed: 2, status: "active" },
    { provider: "anthropic", success: 4, failed: 0, disabled: true },
    { type: "claude", status: "error", success: 1 },
    { provider: "codex", account_type: "api_key", success: 100 },
    { provider: "gemini", success: 100 },
  ]);
  assert.equal(accounts.length, 3);
  assert.deepEqual(totals(accounts), {
    success: 13,
    failed: 2,
    requests: 15,
    ready: 1,
  });
  assert.equal(accountStatus({ status: "disabled" }).label, "Paused");
  assert.equal(accountStatus({ quota: { exceeded: true } }).label, "Limited");
});

test("callback codes and URLs are bound to the current OAuth session", () => {
  const session = { state: "current-state", provider: "claude" };
  assert.deepEqual(callbackPayload("code#current-state", session), {
    provider: "claude",
    state: "current-state",
    code: "code",
  });
  assert.equal(
    callbackPayload(
      "http://localhost:54545/callback?code=123&state=current-state",
      session,
    ).redirect_url,
    "http://localhost:54545/callback?code=123&state=current-state",
  );
  assert.throws(
    () =>
      callbackPayload(
        "http://localhost/callback?state=other&code=123",
        session,
      ),
    /different sign-in/,
  );
  assert.throws(
    () => callbackPayload("code#other", session),
    /different sign-in/,
  );
  assert.throws(() => callbackPayload("  ", session), /Paste/);
});

test("management requests use v8, same-origin auth, and native scalar bodies", async () => {
  const requests = [];
  const client = createClient(async (url, options) => {
    requests.push({ url, options });
    return new Response('{"status":"ok"}');
  });
  client.setKey("private-test-key");
  await client.request("/config/routing/strategy", {
    method: "PUT",
    body: "fill-first",
  });
  await client.request("/credentials/status", {
    method: "PATCH",
    body: { name: "test.json", auth_index: "index", disabled: true },
  });
  assert.equal(requests[0].url, "/v8/management/config/routing/strategy");
  assert.equal(requests[0].options.body, '"fill-first"');
  assert.equal(
    requests[0].options.headers.Authorization,
    "Bearer private-test-key",
  );
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(JSON.parse(requests[1].options.body).auth_index, "index");
});

test("credential uploads preserve multipart boundaries and do not serialize files", async () => {
  const form = new FormData();
  form.append("file", new Blob(['{"type":"claude"}']), "claude.json");
  const client = createClient(async (_url, options) => {
    assert.equal(options.body, form);
    assert.equal(options.headers["Content-Type"], undefined);
    return new Response("{}");
  });
  client.setKey("test-key");
  await client.request("/credentials", { method: "POST", body: form });
});

test("management failures preserve actionable status and error messages", async () => {
  const client = createClient(
    async () => new Response('{"error":"not allowed"}', { status: 403 }),
  );
  client.setKey("test-key");
  await assert.rejects(
    client.request("/credentials"),
    (error) => error.status === 403 && error.message === "not allowed",
  );
  client.setKey("");
  await assert.rejects(
    client.request("/credentials"),
    (error) => error.status === 401,
  );
});

test("locking invalidates responses that were already in flight", async () => {
  let complete;
  const client = createClient(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  client.setKey("test-key");
  const pending = client.request("/credentials");
  client.setKey("");
  complete(new Response('{"files":[{"email":"private@example.com"}]}'));
  await assert.rejects(pending, (error) => error.status === -1);
});

test("locking during response body consumption also discards private data", async () => {
  let completeBody;
  const client = createClient(async () => ({
    ok: true,
    status: 200,
    text: () =>
      new Promise((resolve) => {
        completeBody = resolve;
      }),
  }));
  client.setKey("test-key");
  const pending = client.request("/credentials");
  await Promise.resolve();
  client.setKey("");
  completeBody('{"files":[]}');
  await assert.rejects(pending, (error) => error.status === -1);
});

test("replacing a key invalidates old responses even when the new key has the same text", async () => {
  let complete;
  const client = createClient(() => new Promise(resolve => { complete = resolve; }));
  client.setKey("test-key");
  const pending = client.request("/credentials");
  client.setKey("");
  client.setKey("test-key");
  complete(new Response('{"files":[{"email":"private@example.com"}]}'));
  await assert.rejects(pending, error => error.status === -1);
});

test("an old unauthorized response cannot revoke a newly unlocked session", async () => {
  let complete;
  let revoked = 0;
  let calls = 0;
  const client = createClient((_url, options) => {
    if (++calls === 1) return new Promise(resolve => { complete = resolve; });
    assert.equal(options.headers.Authorization, "Bearer new-key");
    return Promise.resolve(new Response('{"files":[]}'));
  }, () => { revoked++; });
  client.setKey("old-key");
  const pending = client.request("/credentials");
  client.setKey("new-key");
  complete(new Response('{"error":"old key expired"}', { status: 401 }));
  await assert.rejects(pending, error => error.status === -1);
  assert.deepEqual(await client.request("/credentials"), { files: [] });
  assert.equal(revoked, 0);
});

test("401 revokes the in-memory key and does not retry", async () => {
  let calls = 0;
  let revoked = 0;
  const client = createClient(async () => {
    calls++;
    return new Response('{"error":"key revoked"}', { status: 401 });
  }, () => { revoked++; });
  client.setKey("test-key");
  await assert.rejects(client.request("/credentials"), error => error.status === 401 && /key.*rejected/i.test(error.message));
  await assert.rejects(client.request("/credentials"), error => error.status === 401);
  assert.equal(calls, 1);
  assert.equal(revoked, 1);
});

test("callback URL without matching state cannot cross sign-in sessions", () => {
  const session = { state: "current-state", provider: "codex" };
  assert.throws(() => callbackPayload("http://localhost/callback?code=123", session), /state|different sign-in/i);
  assert.throws(() => callbackPayload("http://localhost/callback?code=123&state=", session), /state|different sign-in/i);
  assert.throws(() => callbackPayload("http://localhost/callback?code=123&state=current-state&state=current-state", session), /state|different sign-in/i);
});

test("query retries are limited to transient transport and upstream failures", () => {
  for (const status of [401, 403, 404, -1]) assert.equal(retryManagementQuery(0, new ManagementError("failure", status)), false);
  for (const status of [0, 408, 429, 503]) {
    assert.equal(retryManagementQuery(0, new ManagementError("failure", status)), true);
    assert.equal(retryManagementQuery(2, new ManagementError("failure", status)), false);
  }
  assert.equal(retryManagementQuery(0, new Error("invalid provider payload")), false);
});

test("cancelled queries abort the fetch and cannot return their response body", async () => {
  const controller = new AbortController();
  let capturedSignal;
  let complete;
  const client = createClient((_url, options) => {
    capturedSignal = options.signal;
    return new Promise(resolve => { complete = resolve; });
  });
  client.setKey("test-key");
  const pending = client.request("/credentials", { signal: controller.signal });
  controller.abort();
  assert.equal(capturedSignal.aborted, true);
  complete(new Response('{"files":[]}'));
  await assert.rejects(pending, error => error.status === -1);
});

test("management paths cannot escape the same-origin API prefix", async () => {
  let calls = 0;
  const client = createClient(async () => { calls++; return new Response("{}"); });
  client.setKey("test-key");
  for (const path of ["https://example.com", "//example.com", "/../../api", "/credentials#token"]) {
    await assert.rejects(client.request(path), error => error.status === -1);
  }
  assert.equal(calls, 0);
});
