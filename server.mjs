import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.SHIPYARD_DATA_DIR || path.join(ROOT, 'data'));
const DB_FILE = path.join(DATA_DIR, 'shipyard.json');
const BUILD_DIR = path.join(DATA_DIR, 'builds');
const PORT = process.env.PORT === undefined ? 4173 : Number(process.env.PORT);
const HOST = process.env.HOST || '127.0.0.1';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const COOKIE_SECURE = IS_PRODUCTION || process.env.SHIPYARD_COOKIE_SECURE === '1';
const MAX_CONCURRENT_RELEASES = Number(process.env.SHIPYARD_MAX_CONCURRENT_RELEASES || 2);
if (!Number.isInteger(MAX_CONCURRENT_RELEASES) || MAX_CONCURRENT_RELEASES < 1 || MAX_CONCURRENT_RELEASES > 4) throw new Error('SHIPYARD_MAX_CONCURRENT_RELEASES must be a whole number from 1 to 4.');
const PUBLIC_URL = String(process.env.SHIPYARD_PUBLIC_URL || '').trim().replace(/\/+$/, '');
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '').trim();
const SHIPYARD_FROM_EMAIL = String(process.env.SHIPYARD_FROM_EMAIL || '').trim();
const TRUST_PROXY = process.env.SHIPYARD_TRUST_PROXY === '1';
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('PORT must be a whole number between 0 and 65535.');
const normalizedHost = HOST.toLowerCase().replace(/^\[|\]$/g, '');
const isLoopbackHost = normalizedHost === 'localhost' || normalizedHost === '::1' || /^127\./.test(normalizedHost) || /^::ffff:127\./.test(normalizedHost);
if (IS_PRODUCTION) {
  let publicAddress;
  try { publicAddress = new URL(PUBLIC_URL); } catch { throw new Error('Production hosting requires SHIPYARD_PUBLIC_URL, for example https://shipyard.example.com.'); }
  if (publicAddress.protocol !== 'https:' || publicAddress.username || publicAddress.password || publicAddress.search || publicAddress.hash || publicAddress.pathname !== '/') {
    throw new Error('SHIPYARD_PUBLIC_URL must be an HTTPS origin without credentials, a path, query, or fragment.');
  }
  if (Boolean(RESEND_API_KEY) !== Boolean(SHIPYARD_FROM_EMAIL)) throw new Error('Configure both RESEND_API_KEY and SHIPYARD_FROM_EMAIL, or leave both empty.');
}
if (!isLoopbackHost && process.env.SHIPYARD_ALLOW_REMOTE !== '1') {
  throw new Error('Shipyard binds to loopback by default. Remote binding requires SHIPYARD_ALLOW_REMOTE=1; only use it behind HTTPS and with a private, trusted network.');
}
const running = new Set();
const releaseQueue = [];
let activeReleaseCount = 0;
const authAttempts = new Map();
const GOOGLE_CLIENT_ID_FROM_ENV = String(process.env.GOOGLE_CLIENT_ID || '').trim();
let googleClientId = GOOGLE_CLIENT_ID_FROM_ENV;
const sessions = new Map();
let googleJwksCache = { keys: null, expiresAt: 0 };
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(path.join(DATA_DIR, 'kube-cache'), { recursive: true });

let db;
try { db = JSON.parse(await fs.readFile(DB_FILE, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw new Error(`Could not read Shipyard data at ${DB_FILE}: ${error.message}`);
  db = { services: [], releases: [], events: [] };
}
if (!googleClientId) googleClientId = String(db.googleClientId || '').trim();
db.services ||= [];
db.releases ||= [];
db.events ||= [];
db.users ||= [];
db.passwordResets ||= [];
if (!Array.isArray(db.sessions)) db.sessions = [];
if (typeof db.workspaceName !== 'string' || !db.workspaceName.trim()) db.workspaceName = 'Shipyard workspace';
const removedDemoIds = new Set(db.services.filter(service => service.targetMode === 'demo').map(service => service.id));
const hasRetiredDemoData = removedDemoIds.size > 0 || db.releases.some(release => release.source === 'demo');
let recoveredInterruptedRelease = false;
if (hasRetiredDemoData) {
  db.services = db.services.filter(service => service.targetMode !== 'demo');
  db.releases = db.releases.filter(release => release.source !== 'demo' && !removedDemoIds.has(release.serviceId));
  db.events = db.events.filter(event => !removedDemoIds.has(event.serviceId) && !String(event.title || '').toLowerCase().includes('local demo'));
}
for (const release of db.releases || []) {
  if (['queued', 'running'].includes(release.status)) {
    recoveredInterruptedRelease = true;
    release.status = 'failed';
    release.finishedAt = new Date().toISOString();
    release.log = `${release.log || ''}${new Date().toISOString()}  Control plane restarted before this release finished.\n`.slice(-40_000);
    for (const stage of release.stages || []) if (stage.status === 'running') stage.status = 'failed';
  }
}

let writeQueue = Promise.resolve();
let logPersistTimer;
function persist() {
  if (logPersistTimer) { clearTimeout(logPersistTimer); logPersistTimer = null; }
  const snapshot = JSON.stringify(db, null, 2);
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const tmp = `${DB_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, DB_FILE);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  });
  return writeQueue;
}
function schedulePersist() {
  if (logPersistTimer) return;
  logPersistTimer = setTimeout(() => {
    logPersistTimer = null;
    void persist().catch(error => console.error('Could not save release logs:', error.message));
  }, 500);
  logPersistTimer.unref?.();
}
if (hasRetiredDemoData || recoveredInterruptedRelease) await persist();

function id() { return crypto.randomUUID(); }
function repoShortForEvent(url) { return String(url).replace(/^https?:\/\//, '').replace(/^git@/, '').replace(/\.git$/, ''); }
function safeService(s) { const { webhookSecret, ...rest } = s; return rest; }
function publicUser(user) { return { id: user.id, name: user.name, email: user.email, provider: user.googleSub ? 'google' : 'password' }; }
function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function validEmail(email) { return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email); }
for (const saved of db.sessions) {
  const user = db.users.find(item => item.id === saved.userId);
  if (!user || !/^[a-f0-9]{64}$/.test(saved.tokenHash || '') || !Number.isFinite(saved.expiresAt) || saved.expiresAt <= Date.now()) continue;
  sessions.set(saved.tokenHash, { user: publicUser(user), expiresAt: saved.expiresAt });
}
const validSessionHashes = new Set(sessions.keys());
db.sessions = db.sessions.filter(saved => validSessionHashes.has(saved.tokenHash));
async function createSession(res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  db.sessions = db.sessions.filter(saved => saved.expiresAt > Date.now());
  for (const [hash, saved] of sessions) if (saved.expiresAt <= Date.now()) sessions.delete(hash);
  const existing = db.sessions.filter(saved => saved.userId === user.id).sort((a, b) => b.expiresAt - a.expiresAt);
  for (const stale of existing.slice(9)) { db.sessions = db.sessions.filter(saved => saved.tokenHash !== stale.tokenHash); sessions.delete(stale.tokenHash); }
  db.sessions.push({ tokenHash, userId: user.id, expiresAt });
  sessions.set(tokenHash, { user: publicUser(user), expiresAt });
  try { await persist(); }
  catch (error) { sessions.delete(tokenHash); db.sessions = db.sessions.filter(saved => saved.tokenHash !== tokenHash); throw error; }
  res.setHeader('set-cookie', `shipyard_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${COOKIE_SECURE ? '; Secure' : ''}`);
  return publicUser(user);
}
function scryptPassword(password, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
async function setPassword(user, password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptPassword(password, salt);
  user.passwordSalt = salt.toString('base64url');
  user.passwordHash = hash.toString('base64url');
}
async function verifyPassword(user, password) {
  const salt = Buffer.from(user?.passwordSalt || 'c2hpcHlhcmQtdW5rbm93bi11c2Vy', 'base64url');
  const expected = Buffer.from(user?.passwordHash || 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'base64url');
  const actual = await scryptPassword(password, salt);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual) && Boolean(user?.passwordHash);
}
function sessionFromRequest(req) {
  const cookie = req.headers.cookie || '';
  const token = cookie.split(';').map(part => part.trim()).find(part => part.startsWith('shipyard_session='))?.slice('shipyard_session='.length);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = sessions.get(tokenHash);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(tokenHash);
    db.sessions = db.sessions.filter(saved => saved.tokenHash !== tokenHash);
    void persist().catch(error => console.error('Could not remove expired session:', error.message));
    return null;
  }
  return { token: tokenHash, ...session };
}
function requireSession(req, res) {
  if (sessionFromRequest(req)) return true;
  json(res, 401, { error: 'Sign in to continue.' });
  return false;
}
async function googleKeys() {
  if (googleJwksCache.keys && googleJwksCache.expiresAt > Date.now()) return googleJwksCache.keys;
  const response = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Could not retrieve Google signing keys. Check your internet connection.');
  const data = await response.json();
  if (!Array.isArray(data.keys)) throw new Error('Google returned an invalid signing-key response.');
  const maxAge = Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] || 300);
  googleJwksCache = { keys: data.keys || [], expiresAt: Date.now() + maxAge * 1000 };
  return googleJwksCache.keys;
}
async function verifyGoogleIdToken(token) {
  if (!googleClientId) throw new Error('Google sign-in has not been configured.');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Google returned an invalid credential.');
  let header; let claims;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch { throw new Error('Google returned an invalid credential.'); }
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Google credential uses an unsupported signature.');
  const jwk = (await googleKeys()).find(key => key.kid === header.kid && key.use === 'sig');
  if (!jwk) { googleJwksCache.expiresAt = 0; throw new Error('Google signing key was not found. Try again.'); }
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], 'base64url');
  if (!crypto.verify('RSA-SHA256', signed, publicKey, signature)) throw new Error('Google credential signature is invalid.');
  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) throw new Error('Google credential issuer is invalid.');
  if (!audiences.includes(googleClientId)) throw new Error('Google credential was issued for a different app.');
  if (audiences.length > 1 && claims.azp !== googleClientId) throw new Error('Google credential authorized party is invalid.');
  if (!Number.isFinite(claims.exp) || claims.exp <= now || !Number.isFinite(claims.iat) || claims.iat > now + 300) throw new Error('Google credential has expired or is not yet valid.');
  if (!(claims.email_verified === true || claims.email_verified === 'true') || !claims.sub || !claims.email) throw new Error('Use a verified Google account to sign in.');
  return { sub: claims.sub, email: claims.email, name: claims.name || claims.email.split('@')[0] };
}
function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': "default-src 'self'; script-src 'self' https://accounts.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.googleusercontent.com https://www.gstatic.com; connect-src 'self' https://accounts.google.com; frame-src https://accounts.google.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com",
  });
  res.end(JSON.stringify(body));
}
function errorStatus(error, fallback = 400) {
  return Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : fallback;
}
function allowAuthAttempt(req, res, action, limit, windowMs) {
  const now = Date.now();
  if (authAttempts.size > 2000) for (const [key, bucket] of authAttempts) if (bucket.expiresAt <= now) authAttempts.delete(key);
  const forwarded = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const key = `${forwarded || req.socket.remoteAddress || 'unknown'}:${action}`;
  let bucket = authAttempts.get(key);
  if (!bucket || bucket.expiresAt <= now) {
    bucket = { count: 0, expiresAt: now + windowMs };
    authAttempts.set(key, bucket);
  }
  if (bucket.count >= limit) {
    res.setHeader('retry-after', String(Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000))));
    json(res, 429, { error: 'Too many attempts. Wait a little and try again.' });
    return false;
  }
  bucket.count += 1;
  return true;
}
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    let exceeded = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (exceeded) return;
      size += Buffer.byteLength(chunk);
      if (size > limit) {
        exceeded = true;
        const error = new Error('Request body is too large.');
        error.statusCode = 413;
        reject(error);
        return;
      }
      data += chunk;
    });
    req.on('end', () => { if (!exceeded) resolve(data); });
    req.on('error', reject);
  });
}
function locateCommand(command) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : '';
}
async function capability(command, args, { daemon = false } = {}) {
  const executable = locateCommand(command);
  if (!executable) return { name: command, installed: false, ready: false, detail: 'Not installed or missing from PATH' };
  try {
    const detail = await run(command, args, { timeoutMs: 15_000 });
    return { name: command, installed: true, ready: true, detail: detail.trim().split(/\r?\n/).at(-1) || 'Ready' };
  } catch (error) {
    return { name: command, installed: true, ready: false, detail: daemon ? 'Installed, but its local engine is not running' : error.message.slice(0, 180) };
  }
}
const safeBranch = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const safeSlug = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const safeRelativePath = /^[A-Za-z0-9._/-]{1,160}$/;
const safeRemotePath = /^\/[A-Za-z0-9._/-]{1,180}$/;
const safeHost = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])$/;
const safeUser = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const safeDnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const safeDnsSubdomain = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

function safeRepositoryUrl(value) {
  if (/^(?:https|ssh):\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return ['https:', 'ssh:'].includes(url.protocol) && Boolean(url.hostname) && !url.password && (url.protocol === 'ssh:' || !url.username) && !url.search && !url.hash && Boolean(url.pathname && url.pathname !== '/');
    } catch { return false; }
  }
  return /^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(value) && !value.split(':').at(-1).split('/').some(part => part === '.' || part === '..');
}
function validImageRepository(value) {
  const match = value.match(/^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?\/([a-z0-9][a-z0-9._/-]*)$/);
  if (!match || !match[1].split('.').every(label => safeDnsLabel.test(label)) || (match[2] && Number(match[2]) > 65535)) return false;
  return match[3].split('/').every(part => /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(part));
}

function validateService(input) {
  const deployMode = ['compose-ssh', 'kubernetes', 'helm', 'jenkins'].includes(input.deployMode) ? input.deployMode : 'compose-ssh';
  const fields = {
    name: String(input.name || '').trim(), repoUrl: String(input.repoUrl || '').trim(), branch: String(input.branch || 'main').trim(),
    deployMode,
    host: String(input.host || '').trim(), sshUser: String(input.sshUser || '').trim(), keyPath: String(input.keyPath || '').trim(),
    remotePath: String(input.remotePath || '').trim(), composeFile: String(input.composeFile || 'compose.yaml').trim(),
    envFile: String(input.envFile || '').trim(), healthPort: Number(input.healthPort || 0), healthPath: String(input.healthPath || '/').trim(),
    testCommand: String(input.testCommand || '').trim(), webhookSecret: String(input.webhookSecret || '').trim(),
    kubeconfigPath: String(input.kubeconfigPath || '').trim(), kubeContext: String(input.kubeContext || '').trim(),
    namespace: String(input.namespace || 'default').trim(), imageRepository: String(input.imageRepository || '').trim().toLowerCase(),
    k8sExposure: String(input.k8sExposure || 'internal').trim(),
    ingressHost: String(input.ingressHost || '').trim().toLowerCase(),
    ingressClassName: String(input.ingressClassName || '').trim(),
    ingressTlsSecret: String(input.ingressTlsSecret || '').trim(),
    imagePullSecret: String(input.imagePullSecret || '').trim(),
    chartPath: String(input.chartPath || '').trim(),
    replicas: Number(input.replicas || 2), jenkinsUrl: String(input.jenkinsUrl || '').trim().replace(/\/+$/, ''),
    jenkinsJob: String(input.jenkinsJob || '').trim(), jenkinsUser: String(input.jenkinsUser || '').trim(),
    jenkinsTokenEnv: String(input.jenkinsTokenEnv || 'SHIPYARD_JENKINS_TOKEN').trim(),
  };
  const slug = fields.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!fields.name || fields.name.length > 60 || !safeSlug.test(slug)) throw new Error('Give the service a short name using letters, numbers, and spaces.');
  if (!safeRepositoryUrl(fields.repoUrl)) throw new Error('Use an HTTPS or SSH Git clone URL without a password, query string, or fragment.');
  if (!safeBranch.test(fields.branch) || fields.branch.includes('..')) throw new Error('Branch name contains unsupported characters.');
  if (!Number.isInteger(fields.healthPort) || fields.healthPort < 1 || fields.healthPort > 65535) throw new Error('Set the public server port used by your app, from 1 to 65535.');
  if (!/^\/[A-Za-z0-9/_-]*$/.test(fields.healthPath)) throw new Error('Health path must start with / and contain only letters, numbers, /, _ or -.');
  if (fields.testCommand.length > 300) throw new Error('Pre-deploy command must be 300 characters or less.');
  if (fields.webhookSecret && fields.webhookSecret.length > 200) throw new Error('Webhook secret is too long.');
  if (deployMode === 'compose-ssh') {
    if (!safeHost.test(fields.host)) throw new Error('Enter a server host name or IP address.');
    if (!safeUser.test(fields.sshUser)) throw new Error('SSH user contains unsupported characters.');
    if (!path.isAbsolute(fields.keyPath) || fields.keyPath.includes('\n')) throw new Error('SSH private key path must be absolute and visible on the Shipyard host.');
    if (!safeRemotePath.test(fields.remotePath) || fields.remotePath.includes('..') || fields.remotePath === '/') throw new Error('Use an absolute server folder such as /opt/apps/my-service.');
    if (!safeRelativePath.test(fields.composeFile) || fields.composeFile.startsWith('/') || fields.composeFile.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Compose file must be a relative path inside the repository.');
    if (fields.envFile && (!path.isAbsolute(fields.envFile) || fields.envFile.includes('\n'))) throw new Error('Environment file must be an absolute path visible on the Shipyard host.');
  }
  if (['kubernetes', 'helm'].includes(deployMode)) {
    if (!fields.kubeconfigPath || !path.isAbsolute(fields.kubeconfigPath) || fields.kubeconfigPath.includes('\n')) throw new Error('Choose the absolute path to your Kubernetes kubeconfig file.');
    if (fields.kubeContext && !/^[A-Za-z0-9_.@:/-]{1,120}$/.test(fields.kubeContext)) throw new Error('Kubernetes context contains unsupported characters.');
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(fields.namespace)) throw new Error('Namespace must use lowercase letters, numbers, and hyphens.');
    if (!validImageRepository(fields.imageRepository)) throw new Error('Image repository must look like ghcr.io/your-name/your-app. Sign Docker in to this registry first.');
    if (!Number.isInteger(fields.replicas) || fields.replicas < 1 || fields.replicas > 20) throw new Error('Replicas must be between 1 and 20.');
    if (!['internal', 'load-balancer', 'ingress'].includes(fields.k8sExposure)) throw new Error('Choose internal, load balancer, or Ingress exposure.');
    if (deployMode === 'helm') {
      fields.chartPath ||= `helm/${slug}`;
      if (!safeRelativePath.test(fields.chartPath) || fields.chartPath.startsWith('/') || fields.chartPath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Helm chart path must be a relative path inside the Git repository, such as helm/my-app.');
    }
    if (fields.imagePullSecret && !safeDnsLabel.test(fields.imagePullSecret)) throw new Error('Image pull secret must be an existing Kubernetes Secret name in the selected namespace.');
    if (fields.k8sExposure === 'ingress') {
      if (!safeDnsSubdomain.test(fields.ingressHost) || fields.ingressHost.split('.').some(label => !safeDnsLabel.test(label))) throw new Error('Enter a valid DNS hostname such as app.example.com for the Ingress.');
      if (fields.ingressClassName && (!safeDnsSubdomain.test(fields.ingressClassName) || fields.ingressClassName.split('.').some(label => !safeDnsLabel.test(label)))) throw new Error('Ingress class must be a valid Kubernetes DNS name such as nginx.');
      if (fields.ingressTlsSecret && !safeDnsLabel.test(fields.ingressTlsSecret)) throw new Error('TLS secret must be an existing Kubernetes Secret name in the selected namespace.');
    }
  }
  if (deployMode === 'jenkins') {
    let url;
    try { url = new URL(fields.jenkinsUrl); } catch { throw new Error('Enter your Jenkins URL, for example https://jenkins.example.com.'); }
    const jenkinsHost = url.hostname.replace(/^\[|\]$/g, '');
    const localJenkins = jenkinsHost === 'localhost' || jenkinsHost === '::1' || /^127\./.test(jenkinsHost);
    if (!['http:', 'https:'].includes(url.protocol) || (url.protocol !== 'https:' && !localJenkins) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS Jenkins URL without credentials or query parameters. HTTP is allowed only for a Jenkins server running on this Shipyard host.');
    if (!fields.jenkinsJob || fields.jenkinsJob.split('/').some(part => !/^[A-Za-z0-9_. -]{1,80}$/.test(part) || part === '.' || part === '..')) throw new Error('Enter the Jenkins job path, such as folder/release-app.');
    if (!fields.jenkinsUser || fields.jenkinsUser.length > 120 || /[\r\n:]/.test(fields.jenkinsUser)) throw new Error('Enter the Jenkins API username.');
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(fields.jenkinsTokenEnv)) throw new Error('Token environment variable must be a name such as SHIPYARD_JENKINS_TOKEN.');
    if (!validImageRepository(fields.imageRepository)) throw new Error('Image repository must look like ghcr.io/your-name/your-app.');
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(fields.namespace)) throw new Error('Namespace must use lowercase letters, numbers, and hyphens.');
  }
  return { ...fields, slug, webhookSecret: fields.webhookSecret || crypto.randomBytes(32).toString('hex') };
}

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function targetOf(service) { return `${service.sshUser}@${service.host}`; }
function sshBase(service) {
  return ['-i', service.keyPath, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes', targetOf(service)];
}

function addLog(release, text) {
  const line = String(text).replace(/\x1b\[[0-9;]*m/g, '').replace(/[\r\n]+$/g, '');
  if (!line) return;
  release.log = `${release.log || ''}${new Date().toISOString()}  ${line}\n`.slice(-40_000);
  release.updatedAt = new Date().toISOString();
  schedulePersist();
}
function addEvent(serviceId, releaseId, title, detail, tone = 'neutral') {
  db.events.unshift({ id: id(), serviceId, releaseId, title, detail, tone, at: new Date().toISOString() });
  db.events = db.events.slice(0, 150);
  void persist().catch(error => console.error('Could not save activity:', error.message));
}
function setStage(release, stage, status, detail = '') {
  const current = release.stages.find(x => x.name === stage);
  if (current) { current.status = status; current.detail = detail; }
  release.status = status === 'running' ? 'running' : release.status;
  release.updatedAt = new Date().toISOString();
  addLog(release, `${stage}: ${status}${detail ? ` — ${detail}` : ''}`);
}

function run(binary, args, { onLine, input, cwd, timeoutMs = 30 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    const proc = spawn(binary, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const timeout = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve(value);
    };
    const emit = text => {
      const line = text.length > 16_000 ? `${text.slice(0, 16_000)} … [line truncated]` : text;
      output = `${output}${line}\n`.slice(-1_000_000);
      onLine?.(line);
    };
    const consume = stream => {
      let pending = '';
      stream.on('data', chunk => {
        pending += chunk.toString();
        let newline;
        while ((newline = pending.search(/\r?\n/)) >= 0) {
          emit(pending.slice(0, newline));
          pending = pending.slice(newline + (pending[newline] === '\r' ? 2 : 1));
        }
        while (pending.length > 16_000) {
          emit(pending.slice(0, 16_000));
          pending = pending.slice(16_000);
        }
      });
      stream.on('end', () => { if (pending) emit(pending); });
    };
    consume(proc.stdout); consume(proc.stderr);
    proc.stdin.on('error', () => {});
    proc.on('error', error => finish(error));
    proc.on('close', code => {
      if (timedOut) return finish(new Error(`${binary} exceeded Shipyard's ${Math.round(timeoutMs / 60_000)} minute command limit and was stopped.`));
      if (code === 0) finish(null, output);
      else finish(new Error(`${binary} exited with code ${code}.${output.trim() ? ` ${output.trim().split(/\r?\n/).slice(-5).join(' ').slice(-900)}` : ''}`));
    });
    if (input) proc.stdin.end(input); else proc.stdin.end();
  });
}

async function ssh(service, command, release) {
  return run('ssh', [...sshBase(service), command], { onLine: line => addLog(release, line) });
}
async function uploadEnv(service, release) {
  if (!service.envFile) return;
  await fs.access(service.envFile);
  const remote = `${targetOf(service)}:${service.remotePath}/.shipyard.env`;
  await run('scp', ['-i', service.keyPath, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', service.envFile, remote], { onLine: line => addLog(release, line) });
  await ssh(service, `chmod 600 ${shellQuote(`${service.remotePath}/.shipyard.env`)}`, release);
}

function kubectlArgs(service) {
  const args = ['--cache-dir', path.join(DATA_DIR, 'kube-cache')];
  if (service.kubeconfigPath) args.push('--kubeconfig', path.resolve(service.kubeconfigPath));
  if (service.kubeContext) args.push('--context', service.kubeContext);
  return args;
}
function helmArgs(service) {
  const args = [];
  if (service.kubeconfigPath) args.push('--kubeconfig', path.resolve(service.kubeconfigPath));
  if (service.kubeContext) args.push('--kube-context', service.kubeContext);
  return args;
}
function k8sResources(service, image) {
  const app = service.slug;
  const labels = { 'app.kubernetes.io/name': app, 'app.kubernetes.io/managed-by': 'shipyard', shipyard: 'true' };
  const podSpec = { containers: [{
    name: app, image, imagePullPolicy: 'Always',
    ports: [{ name: 'http', containerPort: service.healthPort, protocol: 'TCP' }],
    readinessProbe: { httpGet: { path: service.healthPath, port: 'http' }, initialDelaySeconds: 5, periodSeconds: 10 },
    livenessProbe: { httpGet: { path: service.healthPath, port: 'http' }, initialDelaySeconds: 15, periodSeconds: 20 },
    resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
  }] };
  if (service.imagePullSecret) podSpec.imagePullSecrets = [{ name: service.imagePullSecret }];
  const items = [
    {
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: app, namespace: service.namespace, labels },
      spec: {
        replicas: service.replicas, revisionHistoryLimit: 5,
        selector: { matchLabels: { 'app.kubernetes.io/name': app } },
        strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
        template: { metadata: { labels: { 'app.kubernetes.io/name': app } }, spec: podSpec },
      },
    },
    {
      apiVersion: 'v1', kind: 'Service', metadata: { name: app, namespace: service.namespace, labels },
      spec: {
        type: service.k8sExposure === 'load-balancer' ? 'LoadBalancer' : 'ClusterIP',
        selector: { 'app.kubernetes.io/name': app },
        ports: [{ name: 'http', port: service.healthPort, targetPort: 'http', protocol: 'TCP' }],
      },
    },
  ];
  if (service.k8sExposure === 'ingress') {
    items.push({
      apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
      metadata: { name: app, namespace: service.namespace, labels },
      spec: {
        ...(service.ingressClassName ? { ingressClassName: service.ingressClassName } : {}),
        ...(service.ingressTlsSecret ? { tls: [{ hosts: [service.ingressHost], secretName: service.ingressTlsSecret }] } : {}),
        rules: [{ host: service.ingressHost, http: { paths: [{
          path: '/', pathType: 'Prefix',
          backend: { service: { name: app, port: { name: 'http' } } },
        }] } }],
      },
    });
  }
  return {
    apiVersion: 'v1', kind: 'List', items,
  };
}
async function deployKubernetes(service, release) {
  const helmMode = service.deployMode === 'helm';
  let workDir = '';
  let previousImage = '';
  let deploymentExisted = false;
  let changed = false;
  try {
    setStage(release, 'Connect', 'running', helmMode ? 'Checking Docker, Helm and Kubernetes access' : 'Checking Docker and Kubernetes access');
    await fs.access(service.kubeconfigPath);
    await run('docker', ['info', '--format', '{{.ServerVersion}}'], { onLine: line => addLog(release, `Docker: ${line}`) });
    if (helmMode) await run('helm', ['version', '--short'], { onLine: line => addLog(release, `Helm: ${line}`) });
    const k = kubectlArgs(service);
    const cluster = await run('kubectl', [...k, 'cluster-info', '--request-timeout=15s'], { onLine: line => addLog(release, line) });
    setStage(release, 'Connect', 'success', cluster.trim().split('\n')[0] || 'Cluster connected');

    setStage(release, 'Update source', 'running', `Cloning ${service.branch}`);
    await fs.mkdir(BUILD_DIR, { recursive: true });
    workDir = await fs.mkdtemp(path.join(BUILD_DIR, `${service.id}-`));
    await run('git', ['clone', '--depth', '1', '--single-branch', '--branch', service.branch, '--', service.repoUrl, workDir], { onLine: line => addLog(release, line) });
    const current = (await run('git', ['-C', workDir, 'rev-parse', 'HEAD'], { onLine: line => addLog(release, line) })).trim().split(/\s+/).at(-1);
    if (!/^[a-f0-9]{40,64}$/i.test(current || '')) throw new Error('Could not identify the checked-out Git commit.');
    release.commit = current;
    setStage(release, 'Update source', 'success', current.slice(0, 12));

    const image = `${service.imageRepository}:${current}`;
    setStage(release, 'Checks', 'running', 'Validating Kubernetes namespace and deployment access');
    let chartDirectory = '';
    if (helmMode) {
      chartDirectory = path.resolve(workDir, service.chartPath);
      if (!chartDirectory.startsWith(`${path.resolve(workDir)}${path.sep}`)) throw new Error('Helm chart path must stay inside the checked-out repository.');
      await fs.access(path.join(chartDirectory, 'Chart.yaml')).catch(() => { throw new Error(`No Chart.yaml found at ${service.chartPath}. Add the chart there or choose the correct chart path.`); });
    }
    const existingNamespace = await run('kubectl', [...k, 'get', 'namespace', service.namespace, '-o', 'name', '--ignore-not-found'], { onLine: line => addLog(release, line) });
    if (!existingNamespace.trim()) {
      addLog(release, `Namespace ${service.namespace} does not exist; creating it.`);
      const namespace = { apiVersion: 'v1', kind: 'Namespace', metadata: { name: service.namespace, labels: { 'app.kubernetes.io/managed-by': 'shipyard', shipyard: 'true' } } };
      try { await run('kubectl', [...k, 'apply', '-f', '-'], { input: JSON.stringify(namespace), onLine: line => addLog(release, line) }); }
      catch (error) { throw new Error(`Namespace "${service.namespace}" does not exist and Shipyard could not create it. Grant namespace creation permission or select a namespace that already exists. ${error.message}`); }
    }
    if (service.imagePullSecret) {
      const secretType = (await run('kubectl', [...k, 'get', 'secret', service.imagePullSecret, '-n', service.namespace, '-o', 'jsonpath={.type}'])).trim();
      if (secretType !== 'kubernetes.io/dockerconfigjson' && secretType !== 'kubernetes.io/dockercfg') throw new Error(`Image pull secret "${service.imagePullSecret}" must be a Docker registry secret in namespace ${service.namespace}.`);
    }
    if (service.k8sExposure === 'ingress' && service.ingressTlsSecret) {
      const secretType = (await run('kubectl', [...k, 'get', 'secret', service.ingressTlsSecret, '-n', service.namespace, '-o', 'jsonpath={.type}'])).trim();
      if (secretType !== 'kubernetes.io/tls') throw new Error(`TLS secret "${service.ingressTlsSecret}" must be a kubernetes.io/tls Secret in namespace ${service.namespace}.`);
    }
    if (helmMode) {
      const existingRelease = await run('helm', [...helmArgs(service), 'status', service.slug, '--namespace', service.namespace, '--output', 'json']).catch(error => {
        if (/release: not found|not found/i.test(error.message)) return '';
        throw error;
      });
      deploymentExisted = Boolean(existingRelease.trim());
    } else {
      const existingDeployment = await run('kubectl', [...k, 'get', 'deployment', service.slug, '-n', service.namespace, '-o', 'name']).catch(error => {
        if (/not found/i.test(error.message)) return '';
        throw error;
      });
      const existingService = await run('kubectl', [...k, 'get', 'service', service.slug, '-n', service.namespace, '-o', 'name']).catch(error => {
        if (/not found/i.test(error.message)) return '';
        throw error;
      });
      const existingIngress = service.k8sExposure === 'ingress'
        ? await run('kubectl', [...k, 'get', 'ingress', service.slug, '-n', service.namespace, '-o', 'name']).catch(error => {
          if (/not found/i.test(error.message)) return '';
          throw error;
        })
        : '';
      for (const [resource, exists] of [['deployment', existingDeployment], ['service', existingService], ['ingress', existingIngress]]) {
        if (!exists.trim()) continue;
        const owner = await run('kubectl', [...k, 'get', resource, service.slug, '-n', service.namespace, '-o', 'jsonpath={.metadata.labels.shipyard}']);
        if (owner.trim() !== 'true') throw new Error(`A Kubernetes ${resource} named "${service.slug}" already exists and is not managed by Shipyard. Choose a different service name to avoid changing it.`);
      }
      if (existingDeployment.trim()) {
        deploymentExisted = true;
        previousImage = (await run('kubectl', [...k, 'get', 'deployment', service.slug, '-n', service.namespace, '-o', 'jsonpath={.spec.template.spec.containers[0].image}'])).trim();
      }
    }
    setStage(release, 'Checks', 'success', `Namespace ${service.namespace} is ready`);

    setStage(release, 'Build image', 'running', image);
    await run('docker', ['build', '--tag', image, '--file', 'Dockerfile', '.'], { cwd: workDir, onLine: line => addLog(release, line) });
    setStage(release, 'Build image', 'success', 'Container image built');

    setStage(release, 'Push image', 'running', 'Pushing to configured container registry');
    await run('docker', ['push', image], { onLine: line => addLog(release, line) });
    setStage(release, 'Push image', 'success', image);

    setStage(release, 'Deploy', 'running', helmMode ? `Applying Helm release ${service.slug} in ${service.namespace}` : `Applying Kubernetes resources in ${service.namespace}`);
    changed = true;
    if (helmMode) {
      const helmUpgradeArgs = [
        ...helmArgs(service), 'upgrade', '--install', service.slug, chartDirectory,
        '--namespace', service.namespace, '--create-namespace', '--wait', '--rollback-on-failure', '--timeout', '180s', '--history-max', '10',
        '--set-string', `fullnameOverride=${service.slug}`, '--set-string', `nameOverride=${service.slug}`,
        '--set-string', `image.repository=${service.imageRepository}`, '--set-string', `image.tag=${current}`,
        '--set', `replicaCount=${service.replicas}`, '--set', `containerPort=${service.healthPort}`,
        '--set', `service.port=${service.healthPort}`, '--set-string', `healthPath=${service.healthPath}`,
        '--set-string', `service.type=${service.k8sExposure === 'load-balancer' ? 'LoadBalancer' : 'ClusterIP'}`,
        '--set', `ingress.enabled=${service.k8sExposure === 'ingress'}`,
      ];
      if (service.imagePullSecret) helmUpgradeArgs.push('--set-string', `imagePullSecrets[0].name=${service.imagePullSecret}`);
      if (service.k8sExposure === 'ingress') {
        helmUpgradeArgs.push('--set-string', `ingress.hosts[0].host=${service.ingressHost}`, '--set-string', 'ingress.hosts[0].paths[0].path=/', '--set-string', 'ingress.hosts[0].paths[0].pathType=Prefix');
        if (service.ingressClassName) helmUpgradeArgs.push('--set-string', `ingress.className=${service.ingressClassName}`);
        if (service.ingressTlsSecret) helmUpgradeArgs.push('--set-string', `ingress.tls[0].secretName=${service.ingressTlsSecret}`, '--set-string', `ingress.tls[0].hosts[0]=${service.ingressHost}`);
      }
      await run('helm', helmUpgradeArgs, { cwd: workDir, onLine: line => addLog(release, line) });
      setStage(release, 'Deploy', 'success', 'Helm release installed and workloads are ready');
      setStage(release, 'Smoke check', 'running', 'Helm waited for Kubernetes workloads to become ready');
      await run('helm', [...helmArgs(service), 'status', service.slug, '--namespace', service.namespace], { onLine: line => addLog(release, line) });
      setStage(release, 'Smoke check', 'success', 'Helm release is deployed and Kubernetes readiness checks passed');
    } else {
      await run('kubectl', [...k, 'apply', '-f', '-', '-n', service.namespace], { input: JSON.stringify(k8sResources(service, image)), onLine: line => addLog(release, line) });
      await run('kubectl', [...k, 'rollout', 'status', `deployment/${service.slug}`, '-n', service.namespace, '--timeout=180s'], { onLine: line => addLog(release, line) });
      setStage(release, 'Deploy', 'success', 'Kubernetes rollout completed');
      setStage(release, 'Smoke check', 'running', 'Waiting for ready pods and HTTP health probes');
      await run('kubectl', [...k, 'wait', '--for=condition=Ready', `pod`, '-l', `app.kubernetes.io/name=${service.slug}`, '-n', service.namespace, '--timeout=60s'], { onLine: line => addLog(release, line) });
      setStage(release, 'Smoke check', 'success', 'Pods are ready and health probes pass');
    }
    if (service.k8sExposure === 'ingress') {
      release.endpoint = `${service.ingressTlsSecret ? 'https' : 'http'}://${service.ingressHost}`;
      addLog(release, `Configured external route: ${release.endpoint}. Shipyard verifies pod health, not public DNS or TLS reachability.`);
    } else if (service.k8sExposure === 'load-balancer') {
      try {
        const addressArgs = [...k, 'get', 'service', service.slug, '-n', service.namespace, '-o', 'jsonpath={.status.loadBalancer.ingress[0].ip}'];
        let address = (await run('kubectl', addressArgs)).trim();
        if (!address) address = (await run('kubectl', [...k, 'get', 'service', service.slug, '-n', service.namespace, '-o', 'jsonpath={.status.loadBalancer.ingress[0].hostname}'])).trim();
        if (address && !/^(?:[A-Za-z0-9.-]+|[0-9A-Fa-f:]+)$/.test(address)) address = '';
        if (address) {
          const authority = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
          release.endpoint = `http://${authority}`;
          addLog(release, `LoadBalancer address: ${release.endpoint}`);
        } else addLog(release, 'LoadBalancer is still provisioning an external address. Check the Service status in your cluster.');
      } catch (error) { addLog(release, `Could not read the LoadBalancer address: ${error.message}`); }
    }
    release.status = 'succeeded';
    release.finishedAt = new Date().toISOString();
    addLog(release, `${helmMode ? 'Helm' : 'Kubernetes'} release succeeded at ${current.slice(0, 12)}.`);
    addEvent(service.id, release.id, `${helmMode ? 'Helm' : 'Kubernetes'} deployment complete`, `${service.name} · ${service.namespace} · ${current.slice(0, 12)}${release.endpoint ? ` · ${release.endpoint}` : ''}`, 'success');
  } catch (error) {
    addLog(release, `${helmMode ? 'Helm' : 'Kubernetes'} deployment failed: ${error.message}`);
    const stage = release.stages.find(x => x.status === 'running');
    if (stage) { stage.status = 'failed'; stage.detail = error.message; }
    if (helmMode && deploymentExisted && changed) {
      release.stages.push({ name: 'Rollback', status: 'waiting', detail: '' });
      setStage(release, 'Rollback', 'running', 'Checking the prior Helm release after the rollback-on-failure upgrade failed');
      try {
        const status = JSON.parse(await run('helm', [...helmArgs(service), 'status', service.slug, '--namespace', service.namespace, '--output', 'json']));
        if (status.info?.status !== 'deployed') throw new Error(`Helm reported release status "${status.info?.status || 'unknown'}".`);
        release.status = 'rolled-back'; release.finishedAt = new Date().toISOString();
        setStage(release, 'Rollback', 'success', 'Helm restored the previous successful release');
        addEvent(service.id, release.id, 'Helm deployment rolled back', service.name, 'warning');
      } catch (rollbackError) {
        release.status = 'failed'; release.finishedAt = new Date().toISOString();
        setStage(release, 'Rollback', 'failed', rollbackError.message);
        addEvent(service.id, release.id, 'Helm rollback status unknown', `${service.name}: ${rollbackError.message}`, 'danger');
      }
    } else if (!helmMode && deploymentExisted && previousImage && changed) {
      release.stages.push({ name: 'Rollback', status: 'waiting', detail: '' });
      setStage(release, 'Rollback', 'running', `Restoring ${previousImage}`);
      try {
        await run('kubectl', [...kubectlArgs(service), 'rollout', 'undo', `deployment/${service.slug}`, '-n', service.namespace], { onLine: line => addLog(release, line) });
        await run('kubectl', [...kubectlArgs(service), 'rollout', 'status', `deployment/${service.slug}`, '-n', service.namespace, '--timeout=180s'], { onLine: line => addLog(release, line) });
        release.status = 'rolled-back'; release.finishedAt = new Date().toISOString();
        setStage(release, 'Rollback', 'success', 'Previous container image restored');
        addEvent(service.id, release.id, 'Kubernetes deployment rolled back', service.name, 'warning');
      } catch (rollbackError) {
        release.status = 'failed'; release.finishedAt = new Date().toISOString();
        setStage(release, 'Rollback', 'failed', rollbackError.message);
        addEvent(service.id, release.id, 'Kubernetes rollback failed', `${service.name}: ${rollbackError.message}`, 'danger');
      }
    } else {
      if (!deploymentExisted && changed && !helmMode) addLog(release, 'The first Kubernetes apply may have created some resources before failing. Inspect the Shipyard-labeled Deployment, Service, or Ingress in the selected namespace.');
      release.status = 'failed'; release.finishedAt = new Date().toISOString();
      addEvent(service.id, release.id, `${helmMode ? 'Helm' : 'Kubernetes'} deployment failed`, `${service.name}: ${error.message}`, 'danger');
    }
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(error => addLog(release, `Could not clean the temporary build folder: ${error.message}`));
    release.updatedAt = new Date().toISOString();
    running.delete(release.serviceId);
    await persist();
  }
}

function jenkinsBase(service) {
  const url = new URL(service.jenkinsUrl);
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}
function jenkinsPath(service) {
  const base = jenkinsBase(service);
  const jobs = service.jenkinsJob.split('/').map(segment => `/job/${encodeURIComponent(segment)}`).join('');
  base.pathname += jobs;
  return base;
}
async function jenkinsRequest(service, target, options = {}) {
  const token = process.env[service.jenkinsTokenEnv];
  if (!token) throw new Error(`Set the ${service.jenkinsTokenEnv} environment variable before starting Shipyard.`);
  const base = new URL(service.jenkinsUrl);
  const url = new URL(target);
  if (url.origin !== base.origin) throw new Error('Jenkins returned a URL on another host; refusing to send credentials.');
  const headers = { authorization: `Basic ${Buffer.from(`${service.jenkinsUser}:${token}`).toString('base64')}`, ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error('Jenkins redirected the request. Set the Jenkins URL to its final HTTPS address.');
  return response;
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function deployJenkins(service, release) {
  try {
    setStage(release, 'Connect', 'running', `Checking ${service.jenkinsUrl}`);
    const job = jenkinsPath(service);
    const jobApi = new URL(`${job.pathname}/api/json`, job.origin);
    const check = await jenkinsRequest(service, jobApi);
    if (!check.ok) throw new Error(`Jenkins job check returned HTTP ${check.status}. Check URL, job path, user, and API token.`);
    setStage(release, 'Connect', 'success', 'Jenkins job is reachable');

    setStage(release, 'Queue', 'running', 'Starting Jenkins pipeline');
    const params = new URLSearchParams({ IMAGE_REPOSITORY: service.imageRepository, KUBE_NAMESPACE: service.namespace });
    const trigger = await jenkinsRequest(service, new URL(`${job.pathname}/buildWithParameters`, job.origin), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params });
    if (![200, 201, 202, 302].includes(trigger.status)) throw new Error(`Jenkins refused to queue the build (HTTP ${trigger.status}). Ensure the job has Build permission and the parameters IMAGE_REPOSITORY and KUBE_NAMESPACE.`);
    const queueLocation = trigger.headers.get('location');
    if (!queueLocation) throw new Error('Jenkins queued no build URL. Check that this job is a parameterized Pipeline.');
    const queueUrl = new URL(queueLocation, job);
    if (queueUrl.origin !== job.origin) throw new Error('Jenkins returned a queue URL on another host.');
    setStage(release, 'Queue', 'success', 'Build queued');
    setStage(release, 'Pipeline', 'running', 'Waiting for Jenkins agent');

    const startedAt = Date.now();
    let buildUrl = '';
    while (Date.now() - startedAt < 10 * 60_000) {
      const queued = await jenkinsRequest(service, new URL('api/json', queueUrl.href.endsWith('/') ? queueUrl : `${queueUrl.href}/`));
      if (!queued.ok) throw new Error(`Jenkins queue returned HTTP ${queued.status}.`);
      const info = await queued.json();
      if (info.cancelled) throw new Error('Jenkins cancelled the queued build.');
      if (info.executable?.url) { buildUrl = info.executable.url; break; }
      await delay(2000);
    }
    if (!buildUrl) throw new Error('Jenkins did not assign an agent within 10 minutes.');
    const build = new URL(buildUrl, job);
    if (build.origin !== job.origin) throw new Error('Jenkins returned a build URL on another host.');
    addLog(release, `Jenkins build ${infoBuildNumber(build.pathname)} started: ${build.href}`);
    let logOffset = 0;
    let result = null;
    const pipelineStarted = Date.now();
    while (Date.now() - pipelineStarted < 60 * 60_000) {
      const logUrl = new URL(`${build.pathname.replace(/\/+$/, '')}/logText/progressiveText?start=${logOffset}`, build.origin);
      const logResponse = await jenkinsRequest(service, logUrl);
      if (!logResponse.ok) throw new Error(`Jenkins console log returned HTTP ${logResponse.status}. Grant this user permission to read the job.`);
      const chunk = await logResponse.text();
      logOffset = Number(logResponse.headers.get('x-text-size')) || logOffset + Buffer.byteLength(chunk);
      if (chunk) for (const line of chunk.split(/\r?\n/)) addLog(release, line);
      const statusResponse = await jenkinsRequest(service, new URL(`${build.pathname.replace(/\/+$/, '')}/api/json?tree=building,result`, build.origin));
      if (!statusResponse.ok) throw new Error(`Jenkins build status returned HTTP ${statusResponse.status}.`);
      const status = await statusResponse.json();
      if (!status.building) { result = status.result; break; }
      await delay(2500);
    }
    if (!result) throw new Error('Jenkins pipeline exceeded Shipyard’s 60 minute wait limit. Check the job directly in Jenkins.');
    setStage(release, 'Pipeline', result === 'SUCCESS' ? 'success' : 'failed', `Jenkins result: ${result}`);
    if (result !== 'SUCCESS') throw new Error(`Jenkins pipeline finished with ${result}.`);
    setStage(release, 'Result', 'success', 'Build and deployment completed in Jenkins');
    release.status = 'succeeded'; release.finishedAt = new Date().toISOString();
    addEvent(service.id, release.id, 'Jenkins pipeline complete', `${service.name} · ${result}`, 'success');
  } catch (error) {
    addLog(release, `Jenkins pipeline failed: ${error.message}`);
    const stage = release.stages.find(item => item.status === 'running');
    if (stage) { stage.status = 'failed'; stage.detail = error.message; }
    release.status = 'failed'; release.finishedAt = new Date().toISOString();
    addEvent(service.id, release.id, 'Jenkins pipeline failed', `${service.name}: ${error.message}`, 'danger');
  } finally {
    release.updatedAt = new Date().toISOString();
    running.delete(release.serviceId);
    await persist();
  }
}
function infoBuildNumber(pathname) { return pathname.match(/\/([0-9]+)\/?$/)?.[1] || 'queued'; }

async function deployCompose(service, release) {
  const app = shellQuote(service.remotePath);
  const branch = shellQuote(service.branch);
  const repo = shellQuote(service.repoUrl);
  const compose = shellQuote(service.composeFile);
  const envArgs = service.envFile ? `--env-file ${shellQuote(`${service.remotePath}/.shipyard.env`)}` : '';
  const composeCmd = `docker compose ${envArgs} -f ${compose}`.replace(/\s+/g, ' ').trim();
  let previous = '';
  let changed = false;
  let current = '';
  try {
    setStage(release, 'Connect', 'running', `${service.sshUser}@${service.host}`);
    await ssh(service, 'printf "SSH connection ready"', release);
    setStage(release, 'Connect', 'success', 'SSH connection ready');

    setStage(release, 'Update source', 'running', `${service.branch} branch`);
    const output = await ssh(service, `set -eu; APP=${app}; REPO=${repo}; BRANCH=${branch}; mkdir -p "$APP"; if [ -d "$APP/.git" ]; then PREVIOUS=$(git -C "$APP" rev-parse HEAD 2>/dev/null || true); git -C "$APP" fetch --prune origin "$BRANCH"; git -C "$APP" checkout -B "$BRANCH" "origin/$BRANCH"; else PREVIOUS=""; git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP"; fi; CURRENT=$(git -C "$APP" rev-parse HEAD); printf '\\nSHIPYARD_PREVIOUS=%s\\nSHIPYARD_COMMIT=%s\\n' "$PREVIOUS" "$CURRENT"`, release);
    previous = output.match(/SHIPYARD_PREVIOUS=([a-f0-9]*)/i)?.[1] || '';
    current = output.match(/SHIPYARD_COMMIT=([a-f0-9]+)/i)?.[1] || '';
    if (!current) throw new Error('Could not read the deployed Git commit from the server.');
    changed = previous !== current;
    release.commit = current;
    release.previousCommit = previous || null;
    setStage(release, 'Update source', 'success', current.slice(0, 12));
    await uploadEnv(service, release);

    setStage(release, 'Checks', 'running', service.testCommand ? 'Running configured pre-deploy command' : 'Validating Compose configuration');
    if (service.testCommand) {
      await ssh(service, `cd ${app} && ${service.testCommand}`, release);
    }
    await ssh(service, `cd ${app} && ${composeCmd} config --quiet`, release);
    setStage(release, 'Checks', 'success', service.testCommand ? 'Pre-deploy command and Compose config passed' : 'Compose config passed');

    setStage(release, 'Build', 'running', 'Building services with Docker Compose');
    await ssh(service, `cd ${app} && ${composeCmd} build`, release);
    setStage(release, 'Build', 'success', 'Images built');

    setStage(release, 'Deploy', 'running', 'Starting updated services');
    await ssh(service, `cd ${app} && ${composeCmd} up -d --remove-orphans`, release);
    setStage(release, 'Deploy', 'success', 'Compose services are running');

    setStage(release, 'Smoke check', 'running', `http://localhost:${service.healthPort}${service.healthPath}`);
    await ssh(service, `curl --fail --silent --show-error --max-time 10 ${shellQuote(`http://127.0.0.1:${service.healthPort}${service.healthPath}`)} >/dev/null`, release);
    setStage(release, 'Smoke check', 'success', 'Endpoint returned HTTP 2xx');
    release.status = 'succeeded';
    release.finishedAt = new Date().toISOString();
    addLog(release, `Release succeeded at ${current.slice(0, 12)}.`);
    addEvent(service.id, release.id, 'Deployment complete', `${service.name} is healthy · ${current.slice(0, 12)}`, 'success');
  } catch (error) {
    addLog(release, `Deployment failed: ${error.message}`);
    const stage = release.stages.find(x => x.status === 'running');
    if (stage) { stage.status = 'failed'; stage.detail = error.message; }
    if (previous && current && changed) {
      try {
        release.stages.push({ name: 'Rollback', status: 'waiting', detail: '' });
        setStage(release, 'Rollback', 'running', `Restoring ${previous.slice(0, 12)}`);
        await ssh(service, `set -eu; cd ${app}; git checkout --detach ${shellQuote(previous)}; ${composeCmd} build; ${composeCmd} up -d --remove-orphans`, release);
        release.status = 'rolled-back';
        release.finishedAt = new Date().toISOString();
        setStage(release, 'Rollback', 'success', `Restored ${previous.slice(0, 12)}`);
        addEvent(service.id, release.id, 'Deployment rolled back', `${service.name} restored to ${previous.slice(0, 12)}`, 'warning');
      } catch (rollbackError) {
        release.status = 'failed';
        release.finishedAt = new Date().toISOString();
        setStage(release, 'Rollback', 'failed', rollbackError.message);
        addEvent(service.id, release.id, 'Rollback failed', `${service.name}: ${rollbackError.message}`, 'danger');
      }
    } else {
      if (current && !previous && changed) {
        release.stages.push({ name: 'Cleanup', status: 'waiting', detail: '' });
        setStage(release, 'Cleanup', 'running', 'Stopping the incomplete first release');
        try {
          await ssh(service, `set -eu; cd ${app}; ${composeCmd} down --remove-orphans`, release);
          setStage(release, 'Cleanup', 'success', 'Stopped containers from the incomplete first release');
        } catch (cleanupError) {
          setStage(release, 'Cleanup', 'failed', `Could not stop the incomplete first release: ${cleanupError.message}`);
        }
      }
      release.status = 'failed';
      release.finishedAt = new Date().toISOString();
      addEvent(service.id, release.id, 'Deployment failed', `${service.name}: ${error.message}`, 'danger');
    }
  } finally {
    release.updatedAt = new Date().toISOString();
    running.delete(release.serviceId);
    await persist();
  }
}

function createRelease(service, source = 'manual') {
  if (running.has(service.id)) throw new Error('A deployment is already running for this service.');
  if (running.size >= 50) {
    const error = new Error('The deployment queue is full. Wait for a release to finish, then try again.');
    error.statusCode = 429;
    throw error;
  }
  const stages = ['kubernetes', 'helm'].includes(service.deployMode)
    ? ['Connect', 'Update source', 'Checks', 'Build image', 'Push image', 'Deploy', 'Smoke check']
    : service.deployMode === 'jenkins' ? ['Connect', 'Queue', 'Pipeline', 'Result']
      : ['Connect', 'Update source', 'Checks', 'Build', 'Deploy', 'Smoke check'];
  const release = {
    id: id(), serviceId: service.id, serviceName: service.name, source, status: 'queued', commit: null, previousCommit: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: '',
    stages: stages.map(name => ({ name, status: 'waiting', detail: '' })),
  };
  db.releases.unshift(release);
  db.releases = db.releases.slice(0, 100);
  running.add(service.id);
  addEvent(service.id, release.id, 'Deployment started', `${service.name} · ${source === 'webhook' ? 'GitHub push' : 'manual run'}`, 'neutral');
  void persist().catch(error => console.error('Could not save deployment:', error.message));
  releaseQueue.push({ service, release });
  addLog(release, `Waiting for a deployment slot. Queue position: ${releaseQueue.length}.`);
  startQueuedReleases();
  return release;
}

function startQueuedReleases() {
  while (activeReleaseCount < MAX_CONCURRENT_RELEASES && releaseQueue.length) {
    const { service, release } = releaseQueue.shift();
    if (!running.has(service.id)) continue;
    activeReleaseCount += 1;
    addLog(release, 'Deployment slot available; starting pipeline.');
    const runner = ['kubernetes', 'helm'].includes(service.deployMode) ? deployKubernetes : service.deployMode === 'jenkins' ? deployJenkins : deployCompose;
    void runner(service, release)
      .catch(error => console.error('Deployment task failed unexpectedly:', error))
      .finally(() => {
        activeReleaseCount -= 1;
        startQueuedReleases();
      });
  }
}

function signatureValid(secret, body, signature) {
  if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/auth/config') {
    return json(res, 200, {
      clientId: googleClientId,
      configured: Boolean(googleClientId),
      canConfigurePublicly: db.users.length === 0,
      clientIdManagedByEnvironment: Boolean(GOOGLE_CLIENT_ID_FROM_ENV),
      passwordResetDelivery: RESEND_API_KEY && SHIPYARD_FROM_EMAIL ? 'email' : IS_PRODUCTION ? 'unavailable' : 'server-console',
      registrationOpen: !IS_PRODUCTION || process.env.SHIPYARD_ALLOW_SIGNUP === '1' || db.users.length === 0,
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/config') {
    if (!allowAuthAttempt(req, res, 'config', 10, 15 * 60_000)) return;
    if (db.users.length > 0 && !requireSession(req, res)) return;
    if (GOOGLE_CLIENT_ID_FROM_ENV) return json(res, 409, { error: 'Google sign-in is managed by the GOOGLE_CLIENT_ID environment variable on the Shipyard server.' });
    try {
      const body = JSON.parse(await readBody(req));
      const clientId = String(body.clientId || '').trim();
      if (!/^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('Enter a valid Google Web OAuth client ID.');
      googleClientId = clientId;
      db.googleClientId = clientId;
      await persist();
      return json(res, 200, { configured: true, clientId });
    } catch (error) { return json(res, errorStatus(error), { error: error.message || 'Could not save Google client ID.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const session = sessionFromRequest(req);
    return json(res, 200, { user: session?.user || null });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    if (!allowAuthAttempt(req, res, 'register', 5, 60 * 60_000)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const email = normalizeEmail(body.email);
      const name = String(body.name || '').trim().slice(0, 80);
      const password = String(body.password || '');
      if (!name) throw new Error('Enter your name.');
      if (!validEmail(email)) throw new Error('Enter a valid email address.');
      if (password.length < 8) throw new Error('Use a password with at least 8 characters.');
      if (password.length > 128) throw new Error('Password must be 128 characters or fewer.');
      if (IS_PRODUCTION && db.users.length > 0 && process.env.SHIPYARD_ALLOW_SIGNUP !== '1') throw new Error('New account creation is closed on this Shipyard installation. Ask its administrator for access.');
      if (db.users.some(user => normalizeEmail(user.email) === email)) throw new Error('An account with that email already exists. Sign in instead.');
      const user = { id: id(), name, email, createdAt: new Date().toISOString() };
      await setPassword(user, password);
      if (db.users.some(item => normalizeEmail(item.email) === email)) throw new Error('An account with that email already exists. Sign in instead.');
      if (IS_PRODUCTION && db.users.length > 0 && process.env.SHIPYARD_ALLOW_SIGNUP !== '1') throw new Error('New account creation is closed on this Shipyard installation. Ask its administrator for access.');
      db.users.push(user);
      await persist();
      return json(res, 201, { user: await createSession(res, user) });
    } catch (error) { return json(res, errorStatus(error), { error: error.message || 'Could not create your account.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    if (!allowAuthAttempt(req, res, 'login', 10, 15 * 60_000)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      if (!validEmail(email) || password.length > 128) return json(res, 401, { error: 'Email or password is incorrect.' });
      const user = db.users.find(item => normalizeEmail(item.email) === email && item.passwordHash);
      if (!await verifyPassword(user, password)) return json(res, 401, { error: 'Email or password is incorrect.' });
      return json(res, 200, { user: await createSession(res, user) });
    } catch (error) { return json(res, errorStatus(error), { error: error.message || 'Could not sign in.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/forgot') {
    if (!allowAuthAttempt(req, res, 'forgot', 5, 60 * 60_000)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const email = normalizeEmail(body.email);
      if (!validEmail(email)) return json(res, 200, { ok: true });
      const user = db.users.find(item => normalizeEmail(item.email) === email && item.passwordHash);
      if (user && (!IS_PRODUCTION || RESEND_API_KEY && SHIPYARD_FROM_EMAIL)) {
        const token = crypto.randomBytes(32).toString('base64url');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expiresAt = Date.now() + 20 * 60 * 1000;
        db.passwordResets = db.passwordResets.filter(reset => reset.userId !== user.id && reset.expiresAt > Date.now());
        db.passwordResets.push({ userId: user.id, tokenHash, expiresAt });
        await persist();
        if (RESEND_API_KEY && SHIPYARD_FROM_EMAIL) {
          try {
            const resetUrl = new URL(`/?reset=${encodeURIComponent(token)}`, `${PUBLIC_URL || `http://localhost:${PORT}`}/`).toString();
            const escapedUrl = resetUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
            const delivery = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json' },
              body: JSON.stringify({
                from: SHIPYARD_FROM_EMAIL,
                to: [user.email],
                subject: 'Reset your Shipyard password',
                text: `Use this one-time link to reset your Shipyard password. It expires in 20 minutes.\n\n${resetUrl}\n\nIf you did not request this, ignore this email.`,
                html: `<p>Use this one-time link to reset your Shipyard password. It expires in 20 minutes.</p><p><a href="${escapedUrl}">Reset password</a></p><p>If you did not request this, ignore this email.</p>`,
              }),
              signal: AbortSignal.timeout(15_000),
            });
            if (!delivery.ok) throw new Error(`Password reset provider returned HTTP ${delivery.status}.`);
          } catch (error) {
            console.error('Password reset email could not be delivered:', error.message);
          }
        } else if (!IS_PRODUCTION) {
          console.log(`Password reset link (expires in 20 minutes): ${PUBLIC_URL || `http://localhost:${PORT}`}/?reset=${encodeURIComponent(token)}`);
        }
      }
      return json(res, 200, { ok: true });
    } catch (error) { return json(res, errorStatus(error), { error: error.message || 'Could not start password recovery.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/reset') {
    if (!allowAuthAttempt(req, res, 'reset', 5, 20 * 60_000)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const token = String(body.token || '');
      const password = String(body.password || '');
      if (password.length < 8) throw new Error('Use a password with at least 8 characters.');
      if (password.length > 128) throw new Error('Password must be 128 characters or fewer.');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const resetIndex = db.passwordResets.findIndex(reset => reset.tokenHash === tokenHash && reset.expiresAt > Date.now());
      if (resetIndex < 0) throw new Error('This reset link is invalid or expired. Request a new one.');
      const reset = db.passwordResets[resetIndex];
      const user = db.users.find(item => item.id === reset.userId);
      if (!user) throw new Error('This account could not be found.');
      await setPassword(user, password);
      db.passwordResets = db.passwordResets.filter(item => item.userId !== user.id);
      for (const [sessionToken, session] of sessions) if (session.user.id === user.id) sessions.delete(sessionToken);
      db.sessions = db.sessions.filter(session => session.userId !== user.id);
      await persist();
      return json(res, 200, { ok: true });
    } catch (error) { return json(res, errorStatus(error), { error: error.message || 'Could not reset password.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/google') {
    if (!allowAuthAttempt(req, res, 'google', 25, 15 * 60_000)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const profile = await verifyGoogleIdToken(body.credential);
      let user = db.users.find(item => item.googleSub === profile.sub);
      if (!user) {
        user = db.users.find(item => normalizeEmail(item.email) === normalizeEmail(profile.email));
        if (user?.googleSub && user.googleSub !== profile.sub) throw new Error('That email is linked to a different Google account.');
        if (!user) {
          if (IS_PRODUCTION && db.users.length > 0 && process.env.SHIPYARD_ALLOW_SIGNUP !== '1') throw new Error('New Google accounts are closed on this Shipyard installation. Ask its administrator for access.');
          user = { id: id(), createdAt: new Date().toISOString() };
          db.users.push(user);
        }
        user.googleSub = profile.sub;
        user.email = normalizeEmail(profile.email);
        user.name = profile.name;
        await persist();
      }
      return json(res, 200, { user: await createSession(res, user) });
    } catch (error) { return json(res, errorStatus(error, 401), { error: error.message || 'Google sign-in failed.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const session = sessionFromRequest(req);
    if (session) {
      sessions.delete(session.token);
      db.sessions = db.sessions.filter(saved => saved.tokenHash !== session.token);
      await persist();
    }
    res.setHeader('set-cookie', `shipyard_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${COOKIE_SECURE ? '; Secure' : ''}`);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/account') {
    if (!requireSession(req, res)) return;
    if (!allowAuthAttempt(req, res, 'account-update', 10, 15 * 60_000)) return;
    try {
      const session = sessionFromRequest(req);
      const user = db.users.find(item => item.id === session.user.id);
      if (!user) throw new Error('Your account could not be found. Sign out and sign in again.');
      const body = JSON.parse(await readBody(req));
      const name = String(body.name || '').trim();
      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');
      if (!name || name.length > 80) throw new Error('Enter a display name up to 80 characters.');
      if (currentPassword || newPassword) {
        if (!user.passwordHash) throw new Error('This account uses Google sign-in. Manage its password through Google.');
        if (!currentPassword || !await verifyPassword(user, currentPassword)) throw new Error('Current password is incorrect.');
        if (newPassword.length < 8 || newPassword.length > 128) throw new Error('New password must be between 8 and 128 characters.');
        await setPassword(user, newPassword);
        db.passwordResets = db.passwordResets.filter(reset => reset.userId !== user.id);
        for (const [token, activeSession] of sessions) if (activeSession.user.id === user.id && token !== session.token) sessions.delete(token);
        db.sessions = db.sessions.filter(saved => saved.userId !== user.id || saved.tokenHash === session.token);
      }
      user.name = name;
      const updatedUser = publicUser(user);
      sessions.get(session.token).user = updatedUser;
      await persist();
      return json(res, 200, { user: updatedUser });
    } catch (error) { return json(res, errorStatus(error), { error: error.message || 'Could not update account settings.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/workspace') {
    if (!requireSession(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const name = String(body.name || '').trim();
      if (!name || name.length > 60) throw new Error('Workspace name must be between 1 and 60 characters.');
      db.workspaceName = name;
      await persist();
      return json(res, 200, { workspaceName: db.workspaceName });
    } catch (error) { return json(res, errorStatus(error), { error: error.message || 'Could not save workspace settings.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/backup') {
    if (!requireSession(req, res)) return;
    const date = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="shipyard-backup-${date}.json"`,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self' https://accounts.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.googleusercontent.com https://www.gstatic.com; connect-src 'self' https://accounts.google.com; frame-src https://accounts.google.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com",
    });
    return res.end(JSON.stringify({ formatVersion: 1, createdAt: new Date().toISOString(), workspace: db }, null, 2));
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    if (!requireSession(req, res)) return;
    return json(res, 200, { workspaceName: db.workspaceName, services: db.services.map(safeService), releases: db.releases, events: db.events, running: [...running] });
  }
  if (req.method === 'GET' && url.pathname === '/api/capabilities') {
    if (!requireSession(req, res)) return;
    const results = await Promise.all([
      capability('git', ['--version']),
      capability('ssh', ['-V']),
      capability('docker', ['info', '--format', '{{.ServerVersion}}'], { daemon: true }),
      capability('kubectl', ['--cache-dir', path.join(DATA_DIR, 'kube-cache'), 'cluster-info', '--request-timeout=5s']),
      capability('helm', ['version', '--short']),
    ]);
    return json(res, 200, {
      tools: results,
      jenkinsTokenAvailable: Boolean(process.env.SHIPYARD_JENKINS_TOKEN) || db.services.some(service => service.jenkinsTokenEnv && process.env[service.jenkinsTokenEnv]),
      configuredServices: db.services.length,
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/services') {
    if (!requireSession(req, res)) return;
    try {
      const input = JSON.parse(await readBody(req));
      const fields = validateService(input);
      if (db.services.some(existing => existing.slug === fields.slug)) throw new Error(`A service named "${fields.name}" already uses this deployment name. Choose a unique service name.`);
      const service = { id: id(), ...fields, createdAt: new Date().toISOString() };
      db.services.unshift(service);
      addEvent(service.id, null, 'Service connected', `Connected to ${repoShortForEvent(service.repoUrl)} on ${service.branch}`, 'neutral');
      await persist();
      return json(res, 201, { service: safeService(service), webhookSecret: service.webhookSecret });
    } catch (e) { return json(res, errorStatus(e), { error: e.message || 'Invalid service configuration.' }); }
  }
  const serviceConfigMatch = url.pathname.match(/^\/api\/services\/([0-9a-f-]+)$/i);
  if (req.method === 'PUT' && serviceConfigMatch) {
    if (!requireSession(req, res)) return;
    const service = db.services.find(item => item.id === serviceConfigMatch[1]);
    if (!service) return json(res, 404, { error: 'Service not found.' });
    if (running.has(service.id)) return json(res, 409, { error: 'Wait for the active deployment to finish before editing this service.' });
    try {
      const body = JSON.parse(await readBody(req));
      const next = validateService(body);
      if (next.deployMode !== service.deployMode) throw new Error('Deployment method cannot be changed on an existing service. Connect a separate service for the new target so the current deployment is not abandoned.');
      if (db.services.some(existing => existing.id !== service.id && existing.slug === next.slug)) throw new Error(`A service named "${next.name}" already uses this deployment name. Choose a unique service name.`);
      if (db.releases.some(release => release.serviceId === service.id) && next.slug !== service.slug) throw new Error('This service name is already used by a deployment. Remove and reconnect the service to change its deployment name.');
      next.webhookSecret = service.webhookSecret;
      next.id = service.id;
      next.createdAt = service.createdAt;
      next.updatedAt = new Date().toISOString();
      db.services[db.services.indexOf(service)] = next;
      addEvent(next.id, null, 'Service updated', `${repoShortForEvent(next.repoUrl)} · ${next.branch}`, 'neutral');
      await persist();
      return json(res, 200, { service: safeService(next) });
    } catch (error) { return json(res, errorStatus(error), { error: error.message || 'Could not update service configuration.' }); }
  }
  const webhookSecretMatch = url.pathname.match(/^\/api\/services\/([0-9a-f-]+)\/webhook-secret$/i);
  if (req.method === 'POST' && webhookSecretMatch) {
    if (!requireSession(req, res)) return;
    if (!allowAuthAttempt(req, res, 'webhook-rotate', 5, 15 * 60_000)) return;
    const service = db.services.find(item => item.id === webhookSecretMatch[1]);
    if (!service) return json(res, 404, { error: 'Service not found.' });
    service.webhookSecret = crypto.randomBytes(32).toString('hex');
    await persist();
    addEvent(service.id, null, 'Webhook secret rotated', 'Update the secret in the GitHub repository webhook settings.', 'warning');
    return json(res, 200, { webhookSecret: service.webhookSecret });
  }
  const webhook = url.pathname.match(/^\/api\/webhooks\/([0-9a-f-]+)$/i);
  if (req.method === 'POST' && webhook) {
    const service = db.services.find(s => s.id === webhook[1]);
    if (!service) return json(res, 404, { error: 'Service not found.' });
    try {
      const raw = await readBody(req);
      if (!signatureValid(service.webhookSecret, raw, req.headers['x-hub-signature-256'])) return json(res, 401, { error: 'Invalid GitHub signature.' });
      if (req.headers['x-github-event'] !== 'push') return json(res, 202, { accepted: false, reason: 'Only push events are deployed.' });
      const payload = JSON.parse(raw);
      if (payload.ref !== `refs/heads/${service.branch}`) return json(res, 202, { accepted: false, reason: 'Push was for a different branch.' });
      const release = createRelease(service, 'webhook');
      return json(res, 202, { accepted: true, releaseId: release.id });
    } catch (e) { return json(res, errorStatus(e), { error: e.message || 'Invalid webhook.' }); }
  }
  const deployMatch = url.pathname.match(/^\/api\/services\/([0-9a-f-]+)\/deploy$/i);
  if (req.method === 'POST' && deployMatch) {
    if (!requireSession(req, res)) return;
    const service = db.services.find(s => s.id === deployMatch[1]);
    if (!service) return json(res, 404, { error: 'Service not found.' });
    try { return json(res, 202, { release: createRelease(service).id }); }
    catch (e) { return json(res, 409, { error: e.message }); }
  }
  const deleteMatch = serviceConfigMatch;
  if (req.method === 'DELETE' && deleteMatch) {
    if (!requireSession(req, res)) return;
    if (running.has(deleteMatch[1])) return json(res, 409, { error: 'Wait for the active deployment to finish first.' });
    const removed = db.services.find(service => service.id === deleteMatch[1]);
    db.services = db.services.filter(s => s.id !== deleteMatch[1]);
    if (removed) addEvent(removed.id, null, 'Service removed', `${removed.name} · configuration removed from Shipyard`, 'warning');
    await persist();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'API route not found.' });
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end('Method not allowed.');
  }
  return serveStatic(url.pathname, res);
}

async function serveStatic(pathname, res) {
  let requested;
  try { requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)); }
  catch { return json(res, 400, { error: 'Invalid URL path.' }); }
  const file = path.resolve(PUBLIC, requested);
  if (!file.startsWith(`${PUBLIC}${path.sep}`) && file !== path.join(PUBLIC, 'index.html')) return json(res, 403, { error: 'Forbidden.' });
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      'content-security-policy': "default-src 'self'; script-src 'self' https://accounts.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.googleusercontent.com https://www.gstatic.com; connect-src 'self' https://accounts.google.com; frame-src https://accounts.google.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com",
    });
    res.end(body);
  } catch { json(res, 404, { error: 'Not found.' }); }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: 'Shipyard encountered an unexpected error.' });
    else res.end();
  });
});
server.requestTimeout = 60_000;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 5_000;
server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : PORT;
  console.log(`Shipyard is ready at http://${HOST}:${port}`);
  if (!isLoopbackHost) console.warn('REMOTE BINDING ENABLED: use only on a trusted private network behind HTTPS. This app has a shared local workspace and is not a multi-user hosted control plane.');
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
