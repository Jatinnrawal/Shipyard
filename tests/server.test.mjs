import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server.mjs');

function startServer(dataDir) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', SHIPYARD_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`Shipyard did not start in time. ${output}`)), 15_000);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve(result);
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        output = `${output}${chunk}`.slice(-8000);
        const ready = output.match(/Shipyard is ready at http:\/\/127\.0\.0\.1:(\d+)/);
        if (ready) finish(null, { child, baseUrl: `http://127.0.0.1:${ready[1]}` });
      });
    }
    child.once('error', error => finish(error));
    child.once('exit', code => finish(new Error(`Shipyard exited before it was ready (code ${code}). ${output}`)));
  });
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

test('local control plane starts safely and persists recovered release state', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shipyard-audit-'));
  const dataDir = path.join(tempRoot, 'isolated-data');
  await fs.mkdir(dataDir);
  const interrupted = {
    services: [],
    releases: [{
      id: 'audit-release', serviceId: 'audit-service', serviceName: 'Audit fixture', source: 'manual',
      status: 'running', createdAt: new Date().toISOString(), log: '',
      stages: [{ name: 'Deploy', status: 'running', detail: '' }],
    }],
    events: [], users: [], passwordResets: [],
  };
  await fs.writeFile(path.join(dataDir, 'shipyard.json'), JSON.stringify(interrupted));

  let server;
  try {
    server = await startServer(dataDir);
    const health = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');

    const page = await fetch(`${server.baseUrl}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.match(await page.text(), /Shipyard — release control/);
    for (const [asset, contentType] of [['/styles.css', 'text/css'], ['/app.js', 'text/javascript'], ['/toolkit.js', 'text/javascript']]) {
      const response = await fetch(`${server.baseUrl}${asset}`);
      assert.equal(response.status, 200, `${asset} is served`);
      assert.ok(response.headers.get('content-type')?.startsWith(contentType));
    }

    assert.equal((await fetch(`${server.baseUrl}/api/state`)).status, 401);
    const registration = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Audit User', email: 'audit@example.test', password: 'audit-password-123' }),
    });
    assert.equal(registration.status, 201);
    const cookie = registration.headers.get('set-cookie')?.split(';', 1)[0];
    assert.match(cookie || '', /^shipyard_session=/);

    const state = await fetch(`${server.baseUrl}/api/state`, { headers: { cookie } });
    assert.equal(state.status, 200);
    const contents = await state.json();
    assert.equal(contents.releases[0].status, 'failed');
    assert.equal(contents.releases[0].stages[0].status, 'failed');

    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'shipyard.json'), 'utf8'));
    assert.equal(persisted.releases[0].status, 'failed');

    const invalidPath = await fetch(`${server.baseUrl}/%E0%A4%A`);
    assert.equal(invalidPath.status, 400);
    const traversal = await fetch(`${server.baseUrl}/%2e%2e%2fserver.mjs`);
    assert.equal(traversal.status, 403);

    const invalidService = await fetch(`${server.baseUrl}/api/services`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({}),
    });
    assert.equal(invalidService.status, 400);
    assert.equal((await fetch(`${server.baseUrl}/api/not-a-route`)).status, 404);
    assert.equal((await fetch(`${server.baseUrl}/`, { method: 'POST' })).status, 405);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const login = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'invalid', password: 'bad' }),
      });
      assert.equal(login.status, 401);
    }
    const throttled = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'invalid', password: 'bad' }),
    });
    assert.equal(throttled.status, 429);
    assert.ok(Number(throttled.headers.get('retry-after')) > 0);

    const credentialUrl = await fetch(`${server.baseUrl}/api/services`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Private app', repoUrl: 'https://deploy-token:secret@github.com/acme/app.git' }),
    });
    assert.equal(credentialUrl.status, 400);
    assert.match((await credentialUrl.json()).error, /without a password/);

    const invalidRegistryPort = await fetch(`${server.baseUrl}/api/services`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'Kubernetes fixture', repoUrl: 'https://github.com/acme/app.git', branch: 'main', deployMode: 'kubernetes',
        kubeconfigPath: path.resolve(tempRoot, 'unused-kubeconfig'), namespace: 'default', imageRepository: 'ghcr.io/acme/app:70000',
        healthPort: '8080', replicas: '2', k8sExposure: 'internal',
      }),
    });
    assert.equal(invalidRegistryPort.status, 400);

    const insecureJenkins = await fetch(`${server.baseUrl}/api/services`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'Jenkins fixture', repoUrl: 'https://github.com/acme/app.git', branch: 'main', deployMode: 'jenkins',
        jenkinsUrl: 'http://jenkins.example.test', jenkinsJob: 'release-app', jenkinsUser: 'build-user',
        imageRepository: 'ghcr.io/acme/app', namespace: 'default', healthPort: '8080',
      }),
    });
    assert.equal(insecureJenkins.status, 400);
    assert.match((await insecureJenkins.json()).error, /HTTPS Jenkins URL/);

    const oversized = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(1_000_001),
    });
    assert.equal(oversized.status, 413);
  } finally {
    if (server) await stopServer(server.child);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('refuses non-loopback binding unless the explicit remote opt-in is set', () => {
  const result = spawnSync(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, HOST: '0.0.0.0', PORT: '4173', SHIPYARD_DATA_DIR: path.join(os.tmpdir(), 'shipyard-remote-bind-audit') },
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Remote binding requires SHIPYARD_ALLOW_REMOTE=1/);
});

test('toolkit emits complete stack bundles and a valid ZIP container', async () => {
  const source = await fs.readFile(path.join(ROOT, 'public', 'toolkit.js'), 'utf8');
  const window = {};
  vm.runInNewContext(source, { window, document: { addEventListener() {} }, TextEncoder, fetch: () => Promise.reject(new Error('unused')) });
  const toolkit = window.ShipyardToolkit;

  for (const config of [
    { runtime: 'node', name: 'Payments API', port: 3001, healthPath: '/healthz', replicas: 3, exposure: 'ingress', ingressHost: 'api.example.test', ingressTlsSecret: 'api-tls' },
    { runtime: 'python', name: 'worker', port: 8000, healthPath: '/ready', replicas: 1, exposure: 'internal' },
    { runtime: 'static', name: 'docs-site', port: 8081, healthPath: '/', replicas: 2, exposure: 'load-balancer' },
  ]) {
    const files = toolkit.generateFiles(config);
    const names = files.map(file => file.path);
    assert.ok(names.includes('Dockerfile'));
    assert.ok(names.includes('compose.yaml'));
    assert.ok(names.includes('.github/workflows/shipyard.yml'));
    assert.ok(names.includes('Jenkinsfile'));
    assert.ok(names.includes('k8s/deployment.yaml'));
    assert.ok(names.includes('helm/' + config.name.toLowerCase().replace(/\s+/g, '-') + '/Chart.yaml'));
    if (config.exposure === 'ingress') assert.ok(names.includes('k8s/ingress.yaml'));
    assert.ok(files.every(file => typeof file.content === 'string' && file.content.length > 0));
    const workflow = files.find(file => file.path === '.github/workflows/shipyard.yml').content;
    assert.match(workflow, /cache-to: type=gha,mode=max/);
    assert.match(workflow, /sbom: true/);
    const dockerfile = files.find(file => file.path === 'Dockerfile').content;
    const dockerignore = files.find(file => file.path === '.dockerignore').content;
    if (config.runtime === 'node') assert.match(dockerfile, /USER node/);
    if (config.runtime === 'python') assert.match(dockerfile, /USER 10001:10001/);
    if (config.runtime === 'static') {
      assert.match(dockerfile, /nginx\/nginx-unprivileged:1-alpine/);
      assert.match(dockerfile, /EXPOSE 8080/);
    }
    assert.match(dockerignore, /k8s\//);
    assert.match(dockerignore, /Jenkinsfile/);
    if (config.runtime === 'node') assert.doesNotMatch(dockerignore, /^dist$/m, 'runtime build output stays in the Node image context');
    assert.match(files.find(file => file.path === 'k8s/deployment.yaml').content, /allowPrivilegeEscalation: false/);
  }

  const ingressFiles = toolkit.generateFiles({ runtime: 'node', name: 'payments api', port: 3001, healthPath: '/healthz', replicas: 3, exposure: 'ingress', ingressHost: 'api.example.test', ingressTlsSecret: 'api-tls' });
  const zip = Buffer.from(toolkit.zipFiles(ingressFiles));
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  let localOffset = 0;
  for (const expected of ingressFiles) {
    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50);
    assert.equal(zip.readUInt16LE(localOffset + 8), 0, 'starter bundle stores ZIP entries without data loss');
    const expectedCrc = zip.readUInt32LE(localOffset + 14);
    const dataLength = zip.readUInt32LE(localOffset + 18);
    const nameLength = zip.readUInt16LE(localOffset + 26);
    const extraLength = zip.readUInt16LE(localOffset + 28);
    const nameStart = localOffset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = zip.toString('utf8', nameStart, nameStart + nameLength);
    const content = zip.subarray(dataStart, dataStart + dataLength);
    assert.equal(name, expected.path);
    assert.equal(content.toString('utf8'), expected.content);
    assert.equal(crc32(content), expectedCrc);
    localOffset = dataStart + dataLength;
  }
  const endRecord = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(endRecord >= 0, 'ZIP end-of-central-directory record exists');
  assert.equal(zip.readUInt16LE(endRecord + 10), ingressFiles.length);
  const manifests = Object.fromEntries(ingressFiles.map(file => [file.path, file.content]));
  assert.match(manifests['k8s/ingress.yaml'], /api\.example\.test/);
  assert.match(manifests['Dockerfile'], /EXPOSE 3001/);
});

test('sessions survive restarts and service settings stay protected and unique', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shipyard-account-audit-'));
  const dataDir = path.join(tempRoot, 'data');
  await fs.mkdir(dataDir);
  let server;
  try {
    server = await startServer(dataDir);
    const registration = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Shipyard Owner', email: 'owner@example.test', password: 'owner-password-123' }),
    });
    assert.equal(registration.status, 201);
    const cookie = registration.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);

    const clientId = '123456789-owner.apps.googleusercontent.com';
    const publicSettingsChange = await fetch(`${server.baseUrl}/api/auth/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId }),
    });
    assert.equal(publicSettingsChange.status, 401);
    const privateSettingsChange = await fetch(`${server.baseUrl}/api/auth/config`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ clientId }),
    });
    assert.equal(privateSettingsChange.status, 200);

    const serviceConfig = {
      name: 'Release API', repoUrl: 'https://github.com/acme/release-api.git', branch: 'main', deployMode: 'compose-ssh',
      host: '203.0.113.10', sshUser: 'deploy', keyPath: path.resolve(tempRoot, 'deploy.key'),
      remotePath: '/opt/apps/release-api', composeFile: 'compose.yaml', healthPort: '8080', healthPath: '/health',
    };
    const created = await fetch(`${server.baseUrl}/api/services`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(serviceConfig),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.ok(createdBody.webhookSecret);
    const serviceId = createdBody.service.id;

    const duplicate = await fetch(`${server.baseUrl}/api/services`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ...serviceConfig, name: 'release-api' }),
    });
    assert.equal(duplicate.status, 400);

    const updated = await fetch(`${server.baseUrl}/api/services/${serviceId}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ...serviceConfig, name: 'Release API V2', host: '203.0.113.11' }),
    });
    assert.equal(updated.status, 200);
    const updatedBody = await updated.json();
    assert.equal(updatedBody.service.slug, 'release-api-v2');
    assert.equal(Object.hasOwn(updatedBody.service, 'webhookSecret'), false);

    const rotated = await fetch(`${server.baseUrl}/api/services/${serviceId}/webhook-secret`, { method: 'POST', headers: { cookie } });
    assert.equal(rotated.status, 200);
    const rotatedBody = await rotated.json();
    assert.notEqual(rotatedBody.webhookSecret, createdBody.webhookSecret);

    await stopServer(server.child);
    server = null;
    server = await startServer(dataDir);
    const session = await fetch(`${server.baseUrl}/api/auth/me`, { headers: { cookie } });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).user.email, 'owner@example.test');
    const state = await fetch(`${server.baseUrl}/api/state`, { headers: { cookie } });
    assert.equal(state.status, 200);
    const saved = await state.json();
    assert.equal(saved.services[0].host, '203.0.113.11');
    assert.equal(Object.hasOwn(saved.services[0], 'webhookSecret'), false);
  } finally {
    if (server) await stopServer(server.child);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
