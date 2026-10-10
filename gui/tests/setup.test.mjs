import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { parse } from 'yaml';

const execute = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/setup-subscriptions.mjs');

test('Docker setup preserves local profiles and credentials across repeated initialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subscription-setup-test-'));
  try {
    await mkdir(join(root, 'scripts'));
    await symlink(resolve(dirname(source), '../gui'), join(root, 'gui'), 'dir');
    const script = join(root, 'scripts/setup-subscriptions.mjs');
    await copyFile(source, script);
    await execute(process.execPath, [script], { cwd: tmpdir() });
    const localText = await readFile(join(root, 'config.yaml'), 'utf8');
    const local = parse(localText);
    assert.equal(local.server.host, '127.0.0.1');
    assert.equal(local.oauth['auth-dir'], join(root, 'auths'));

    await execute(process.execPath, [script, '--docker'], { cwd: tmpdir() });
    const dockerPath = join(root, 'docker-data/config/config.yaml');
    const dockerText = await readFile(dockerPath, 'utf8');
    const docker = parse(dockerText);
    const keyPath = join(root, 'docker-data/config/management-key');
    assert.equal(await readFile(keyPath, 'utf8'), docker.management['secret-key']);
    assert.equal(docker.server.host, '127.0.0.1');
    assert.deepEqual(docker.server['trusted-proxies'], []);
    assert.equal(docker.management['allow-remote'], false);
    assert.equal(docker.oauth['auth-dir'], '/CLIProxyAPI/auths');
    assert.equal(docker.observability.logs['logging-to-file'], true);
    assert.equal(docker.observability.logs['request-log'], false);
    const runtimePath = join(root, 'docker-data/runtime.env');
    const runtime = await readFile(runtimePath, 'utf8');
    assert.equal(runtime, `CLI_PROXY_USER=${process.getuid()}:${process.getgid()}\n`);
    assert.notEqual(docker.management['secret-key'], local.management['secret-key']);
    assert.notEqual(docker.management['secret-key'], docker.access['api-keys'][0]);
    assert.equal(await readFile(join(root, 'config.yaml'), 'utf8'), localText);
    const authPath = join(root, 'docker-data/auths/account.json');
    await writeFile(authPath, '{"preserved":true}', { mode: 0o600 });
    const hashedText = dockerText.replace(docker.management['secret-key'], '$2a$10$already-hashed');
    await writeFile(dockerPath, hashedText);
    await execute(process.execPath, [script, '--docker']);
    assert.equal(await readFile(dockerPath, 'utf8'), hashedText);
    assert.equal(await readFile(runtimePath, 'utf8'), runtime);
    assert.equal(await readFile(keyPath, 'utf8'), docker.management['secret-key']);
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(authPath, 'utf8'), '{"preserved":true}');
    for (const directory of ['docker-data/config', 'docker-data/auths', 'docker-data/logs']) {
      assert.equal((await stat(join(root, directory))).isDirectory(), true);
      if (process.platform !== 'win32') assert.equal((await stat(join(root, directory))).mode & 0o777, 0o700);
    }
    if (process.platform !== 'win32') assert.equal((await stat(dockerPath)).mode & 0o777, 0o600);
    await assert.rejects(execute(process.execPath, [script, '--unknown']));
    assert.equal(await readFile(dockerPath, 'utf8'), hashedText);
    await rm(keyPath);
    await assert.rejects(execute(process.execPath, [script, '--docker']), /original management key is unavailable/);
    await assert.rejects(readFile(keyPath, 'utf8'), { code: 'ENOENT' });
    assert.equal(await readFile(dockerPath, 'utf8'), hashedText);
    await writeFile(dockerPath, dockerText);
    await execute(process.execPath, [script, '--docker']);
    assert.equal(await readFile(keyPath, 'utf8'), docker.management['secret-key']);
    await writeFile(keyPath, '');
    await assert.rejects(execute(process.execPath, [script, '--docker']), /saved management-key is invalid/);
    assert.equal(await readFile(keyPath, 'utf8'), '');
    await writeFile(keyPath, 'wrong-original-key');
    await assert.rejects(execute(process.execPath, [script, '--docker']), /saved management-key disagree/);
    assert.equal(await readFile(dockerPath, 'utf8'), dockerText);
    await writeFile(keyPath, docker.management['secret-key']);
    await writeFile(dockerPath, hashedText);
    await writeFile(runtimePath, 'CLI_PROXY_USER=99999:99999\n');
    await assert.rejects(execute(process.execPath, [script, '--docker']), /another user|original profile owner/);
    assert.equal(await readFile(runtimePath, 'utf8'), 'CLI_PROXY_USER=99999:99999\n');
    assert.equal(await readFile(dockerPath, 'utf8'), hashedText);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
