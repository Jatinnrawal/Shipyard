if (location.protocol !== 'file:') {
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const viewRoot = $('#view');
const serviceDialog = $('#service-dialog');
const webhookDialog = $('#webhook-dialog');
const logDialog = $('#log-dialog');
const accountDialog = $('#account-dialog');
const workspaceDialog = $('#workspace-dialog');
const helpDialog = $('#help-dialog');
let state = { workspaceName: 'Shipyard workspace', services: [], releases: [], events: [], running: [] };
let activeView = 'overview';
let selectedService = null;
let editingServiceId = null;
let viewedLogId = null;
let toastTimer;
let authConfig = null;
let authUser = null;
let googleInitialized = false;
let resetToken = new URLSearchParams(location.search).get('reset') || '';

function esc(value = '') { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function serviceFor(id) { return state.services.find(x => x.id === id); }
function releaseFor(id) { return state.releases.find(x => x.id === id); }
function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}
function timeAgo(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function statusClass(status) {
  if (status === 'succeeded' || status === 'success') return 'success';
  if (status === 'running') return 'running';
  if (status === 'failed') return 'failed';
  if (status === 'rolled-back') return 'rolled-back';
  if (status === 'warning') return 'warning';
  return '';
}
function statusLabel(status) {
  return ({ succeeded: 'HEALTHY', running: 'IN PROGRESS', queued: 'QUEUED', failed: 'FAILED', 'rolled-back': 'ROLLED BACK', waiting: 'WAITING', success: 'DONE' })[status] || String(status || 'UNKNOWN').toUpperCase();
}
function pill(status) { return `<span class="status-pill ${statusClass(status)}">${esc(statusLabel(status))}</span>`; }
function repoShort(url = '') { return url.replace(/^https?:\/\//, '').replace(/^git@/, '').replace(/\.git$/, ''); }
function serviceIcon(name = '') { return esc((name.match(/[A-Za-z0-9]/g) || ['S']).slice(0, 2).join('').toUpperCase()); }
function toast(message, kind = '') {
  const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = message;
  $('#toast-region').append(el); setTimeout(() => el.remove(), 4000);
}
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function setAuthScreen(which) {
  for (const name of ['loading', 'setup', 'login', 'signup', 'forgot', 'reset']) $(`#auth-${name}`).hidden = name !== which;
  const registrationOpen = authConfig?.registrationOpen !== false;
  $('#signup-form').hidden = !registrationOpen;
  $('#signup-closed').hidden = registrationOpen;
  $('#login-signup-switch').hidden = !registrationOpen;
  const socialVisible = ['login', 'signup'].includes(which);
  $('#auth-social').hidden = !socialVisible;
  $('#google-button').hidden = !authConfig?.configured;
  $('#google-config-link').hidden = Boolean(authConfig?.configured) || !authConfig?.canConfigurePublicly;
  $('#google-change-link').hidden = true;
  $('#auth-gate').hidden = false;
  $('.app-shell').hidden = true;
  if (socialVisible && authConfig?.configured) void renderGoogleButton();
}
function openGoogleSettings() {
  const input = $('#client-id-input');
  const submit = $('#client-form button[type="submit"]');
  const managed = Boolean(authConfig?.clientIdManagedByEnvironment);
  input.value = authConfig?.clientId || '';
  input.readOnly = managed;
  submit.disabled = managed;
  $('#client-error').textContent = managed ? 'Google sign-in is managed by GOOGLE_CLIENT_ID on the Shipyard server. Change the server setting and restart Shipyard.' : '';
  $('#client-error').hidden = !managed;
  setAuthScreen('setup');
}
function enterApp(user) {
  authUser = user;
  $('#auth-gate').hidden = true;
  $('.app-shell').hidden = false;
  const initial = (user?.name || user?.email || 'S').trim().slice(0, 1).toUpperCase();
  $('#account-button').textContent = initial;
  $('#account-button').title = `${user?.email || 'Signed in'} · Account menu`;
  $('#account-name').textContent = user?.name || 'Account';
  $('#account-email').textContent = user?.email || '';
  refresh();
}
function closeAccountMenu() {
  $('#account-menu').hidden = true;
  $('#account-button').setAttribute('aria-expanded', 'false');
}
function loadGoogleLibrary() {
  if (window.google?.accounts?.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let script = document.getElementById('google-identity-script');
    if (!script) {
      script = document.createElement('script');
      script.id = 'google-identity-script';
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      document.head.append(script);
    }
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', () => reject(new Error('Could not load Google sign-in. Check your internet connection.')), { once: true });
    if (window.google?.accounts?.id) resolve();
  });
}
async function renderGoogleButton() {
  $('#google-error').hidden = true;
  try {
    await loadGoogleLibrary();
    if (!googleInitialized) {
      window.google.accounts.id.initialize({
        client_id: authConfig.clientId,
        callback: async response => {
          $('#google-error').hidden = true;
          try {
            const result = await request('/api/auth/google', { method: 'POST', body: JSON.stringify({ credential: response.credential }) });
            enterApp(result.user);
          } catch (error) { $('#google-error').textContent = error.message; $('#google-error').hidden = false; }
        },
      });
      googleInitialized = true;
    }
    $('#google-button').replaceChildren();
    window.google.accounts.id.renderButton($('#google-button'), { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular', logo_alignment: 'left', width: 340 });
  } catch (error) { $('#google-error').textContent = error.message; $('#google-error').hidden = false; }
}
async function boot() {
  setAuthScreen('loading');
  $('#auth-origin').textContent = location.origin;
  try {
    authConfig = await request('/api/auth/config');
    if (resetToken) {
      setAuthScreen('reset');
      return;
    }
    const session = await request('/api/auth/me');
    if (session.user) enterApp(session.user);
    else setAuthScreen('login');
  } catch (error) {
    setAuthScreen('loading');
    $('#auth-loading').innerHTML = `<div class="auth-kicker">SHIPYARD COULD NOT CONNECT</div><h1>Start the local app</h1><p>${esc(error.message)}</p><p>Leave the Shipyard terminal window running, then reload this page.</p>`;
  }
}
async function refresh() {
  try {
    state = await request('/api/state');
    $('#service-count').textContent = state.services.length;
    $('#workspace-menu-name').textContent = `Workspace · ${state.workspaceName || 'Shipyard workspace'}`;
    const isRunning = state.running.length > 0;
    $('#system-status-text').textContent = isRunning ? 'Release in progress' : 'Control plane ready';
    // The Toolkit has its own local capability refresh and does not display release state.
    // Rebuilding it on the global 3-second poll steals focus from fields while the user types.
    if (activeView !== 'toolkit') render();
    if (logDialog.open && viewedLogId) {
      const release = releaseFor(viewedLogId);
      if (release) { $('#log-content').textContent = release.log || 'No output yet.'; $('#log-content').scrollTop = $('#log-content').scrollHeight; }
    }
  } catch (e) {
    if (e.message.includes('Sign in to continue')) { authUser = null; setAuthScreen('login'); }
    else toast(`Could not load Shipyard: ${e.message}`, 'error');
  }
}
function nav(view) {
  activeView = view;
  selectedService = null;
  $$('.nav-item').forEach(x => x.classList.toggle('active', x.dataset.view === view));
  render();
}
function syncTargetFields() {
  const mode = $('#service-form [name="deployMode"]').value || 'compose-ssh';
  for (const section of $$('[data-target-fields]', $('#service-form'))) {
    const active = section.dataset.targetFields === mode || (section.dataset.targetFields === 'kubernetes' && ['kubernetes', 'helm'].includes(mode));
    section.hidden = !active;
    for (const control of $$('input, select, textarea', section)) {
      control.disabled = !active;
      control.required = active && control.hasAttribute('data-required');
    }
    const helmField = $('[data-helm-only]', section);
    if (helmField) {
      const helmActive = mode === 'helm';
      helmField.hidden = !helmActive;
      const chartPath = $('[name="chartPath"]', helmField);
      chartPath.disabled = !helmActive;
      chartPath.required = helmActive;
    }
  }
  const ingressFields = $('[data-k8s-ingress]', $('#service-form'));
  const ingressActive = ['kubernetes', 'helm'].includes(mode) && $('#service-form [name="k8sExposure"]').value === 'ingress';
  ingressFields.hidden = !ingressActive;
  for (const control of $$('input, select, textarea', ingressFields)) {
    control.disabled = !ingressActive;
    control.required = ingressActive && control.hasAttribute('data-required');
  }
}
function openAdd() {
  editingServiceId = null;
  $('#form-error').hidden = true;
  $('#service-form').reset();
  $('#service-form [name="deployMode"]').disabled = false;
  $('#service-dialog-title').textContent = 'New deployment service';
  $('#service-dialog-description').textContent = 'Choose whether Shipyard deploys over SSH, builds and deploys to Kubernetes, deploys a Helm chart, or triggers Jenkins to run the pipeline.';
  $('#service-submit-button').innerHTML = '<span>Connect service</span><span>→</span>';
  $('#service-form [name="deployMode"]').value = 'compose-ssh';
  $('#service-form [name="branch"]').value = 'main';
  $('#service-form [name="composeFile"]').value = 'compose.yaml';
  $('#service-form [name="healthPort"]').value = '8080';
  $('#service-form [name="healthPath"]').value = '/';
  syncTargetFields();
  serviceDialog.showModal();
}
function openEdit(service) {
  editingServiceId = service.id;
  $('#form-error').hidden = true;
  $('#service-form').reset();
  $('#service-form [name="deployMode"]').disabled = true;
  for (const control of $$('input[name], select[name]', $('#service-form'))) {
    const targetFields = control.closest('[data-target-fields]');
    if (targetFields && targetFields.dataset.targetFields !== service.deployMode && !(targetFields.dataset.targetFields === 'kubernetes' && service.deployMode === 'helm')) continue;
    if (Object.hasOwn(service, control.name)) control.value = service[control.name] ?? '';
  }
  $('#service-dialog-title').textContent = `Edit ${service.name}`;
  $('#service-dialog-description').textContent = 'Update this service configuration. Deployment method stays fixed, and its GitHub webhook secret remains unchanged.';
  $('#service-submit-button').innerHTML = '<span>Save changes</span><span>✓</span>';
  syncTargetFields();
  serviceDialog.showModal();
}
function stageMarkup(stages = []) {
  const names = stages.length ? stages.map(x => x.name) : ['Connect', 'Update source', 'Checks', 'Build', 'Deploy', 'Smoke check'];
  if (!names.includes('Rollback') && stages.some(x => x.name === 'Rollback')) names.push('Rollback');
  const states = new Map(stages.map(x => [x.name, x]));
  return `<div class="stage-track" style="--stage-count:${names.length}">${names.map((name, i) => { const s = states.get(name) || { status: 'waiting' }; return `<div class="stage ${esc(s.status)}"><div class="stage-dot">${s.status === 'success' ? '✓' : s.status === 'failed' ? '!' : s.status === 'running' ? '•' : i + 1}</div><div class="stage-label">${esc(name)}</div></div>`; }).join('')}</div>`;
}
function eventMarkup(event) {
  const service = serviceFor(event.serviceId);
  return `<div class="activity-item"><i class="activity-marker ${esc(event.tone || '')}"></i><div><div class="activity-title">${esc(event.title)}</div><div class="activity-detail">${esc(service?.name || event.detail || '')}${service && event.detail ? ` · ${esc(event.detail)}` : ''}</div></div><time class="activity-time" title="${esc(fmtDate(event.at))}">${esc(timeAgo(event.at))}</time></div>`;
}
function serviceTarget(service) {
  if (['kubernetes', 'helm'].includes(service.deployMode)) {
    const exposure = service.k8sExposure === 'ingress' ? `Ingress · ${service.ingressHost}` : service.k8sExposure === 'load-balancer' ? 'LoadBalancer' : 'internal';
    return `Kubernetes · ${service.namespace || 'default'} · ${exposure}`;
  }
  if (service.deployMode === 'jenkins') return `Jenkins · ${service.jenkinsJob || 'pipeline'}`;
  return `${service.sshUser}@${service.host}`;
}
function serviceRow(service) {
  const recent = state.releases.find(r => r.serviceId === service.id);
  const mode = service.deployMode === 'helm' ? 'HELM' : service.deployMode === 'kubernetes' ? 'KUBERNETES' : service.deployMode === 'jenkins' ? 'JENKINS' : 'DOCKER COMPOSE';
  return `<div class="service-row"><div class="service-icon">${serviceIcon(service.name)}</div><div class="service-main"><div class="service-name-line"><span class="service-name" data-action="service-detail" data-id="${service.id}">${esc(service.name)}</span>${pill(recent?.status === 'succeeded' ? 'succeeded' : recent?.status || 'waiting')}</div><div class="service-meta">${esc(repoShort(service.repoUrl))} <span>·</span> ${esc(service.branch)} <span>·</span> ${esc(mode)}</div></div><div class="service-right"><div class="service-target"><b>${esc(serviceTarget(service))}</b>${esc(service.remotePath || service.imageRepository || '')}</div><button class="button mini-button" data-action="deploy" data-id="${service.id}" ${state.running.includes(service.id) ? 'disabled' : ''}>Deploy ↑</button></div></div>`;
}
function releaseRow(release) {
  const source = release.source === 'webhook' ? 'GitHub push' : 'Manual';
  return `<div class="release-row"><div><div class="release-service">${esc(release.serviceName)}</div><div class="release-meta">${release.commit ? esc(release.commit.slice(0, 12)) : 'Commit pending'} · ${esc(source)} · ${esc(fmtDate(release.createdAt))}</div>${release.endpoint ? `<div class="release-meta">Endpoint · ${esc(release.endpoint)}</div>` : ''}</div>${pill(release.status)}<div class="release-row-actions"><button class="text-link" data-action="logs" data-id="${release.id}">View logs</button></div></div>`;
}
function emptyState(title, message) {
  return `<div class="empty-state"><div class="empty-visual">↟</div><h3>${esc(title)}</h3><p>${esc(message)}</p><button class="button button-primary" data-action="add-service">Connect a service <span>→</span></button></div>`;
}
function modernOverview() {
  const succeeded = state.releases.filter(item => item.status === 'succeeded').length;
  const failed = state.releases.filter(item => ['failed', 'rolled-back'].includes(item.status)).length;
  const active = state.releases.filter(item => ['queued', 'running'].includes(item.status)).length;
  const completed = succeeded + failed;
  const rate = completed ? Math.round(succeeded / completed * 100) : null;
  const healthyServices = state.services.filter(service => state.releases.find(item => item.serviceId === service.id)?.status === 'succeeded').length;
  const latest = state.releases[0];
  return `<div class="page-heading"><div><div class="eyebrow">RELEASE OPERATIONS</div><h1>Overview</h1><p>Deployment activity and health across your services.</p></div><div class="heading-tools">${!state.services.length ? '<button class="button button-dark" data-action="add-service">＋ New service</button>' : ''}</div></div>
    <div class="dashboard-top-grid"><section class="panel release-summary"><div class="panel-head"><div><div class="panel-title">Release summary</div><div class="panel-subtitle">All-time deployment counts</div></div><button class="text-link" data-view="deployments">View releases →</button></div><div class="release-summary-grid"><div><span>Total releases</span><b>${state.releases.length}</b></div><div><span>Successful</span><b class="summary-green">${succeeded}</b></div><div><span>Failed / rolled back</span><b class="summary-pink">${failed}</b></div><div><span>In progress</span><b class="summary-blue">${active}</b></div></div><div class="release-summary-note">${latest ? `Most recent: ${esc(latest.serviceName)} · ${esc(statusLabel(latest.status))} · ${esc(fmtDate(latest.createdAt))}` : 'Release totals appear here after you deploy a connected service.'}</div></section>
      <section class="panel health-card"><div class="panel-head"><div><div class="panel-title">Release health</div><div class="panel-subtitle">Based on completed deployments</div></div><span class="health-mark">↗</span></div><div class="health-score">${rate === null ? '—' : `${rate}%`}</div><div class="health-caption">success rate</div><div class="health-meter"><span style="width:${rate ?? 0}%"></span></div><div class="health-breakdown"><div><span class="health-swatch swatch-green"></span><span>Healthy services</span><b>${healthyServices}</b></div><div><span class="health-swatch swatch-gray"></span><span>Connected services</span><b>${state.services.length}</b></div><div><span class="health-swatch swatch-blue"></span><span>Releases in progress</span><b>${active}</b></div></div></section></div>
    <div class="dashboard-bottom-grid"><section class="panel"><div class="panel-head"><div><div class="panel-title">Services</div><div class="panel-subtitle">Deployment targets in this workspace</div></div><button class="text-link" data-view="services">View services →</button></div>${state.services.length ? `<div class="service-list">${state.services.slice(0, 5).map(serviceRow).join('')}</div>` : '<div class="empty-inline">No connected services yet. Connect a repository and server to get started.</div>'}</section><section class="panel"><div class="panel-head"><div><div class="panel-title">Recent activity</div><div class="panel-subtitle">Latest release events</div></div><button class="text-link" data-view="activity">View activity →</button></div><div class="activity-list">${state.events.length ? state.events.slice(0, 5).map(eventMarkup).join('') : '<div class="empty-inline">Activity will appear here after the first release.</div>'}</div></section></div>
    ${latest ? `<section class="panel pipeline-card"><div class="panel-head"><div><div class="panel-title">Latest pipeline</div><div class="panel-subtitle">${esc(latest.serviceName)} · ${esc(fmtDate(latest.createdAt))}</div></div><div class="release-row-actions">${pill(latest.status)}<button class="text-link" data-action="logs" data-id="${latest.id}">Full logs ↗</button></div></div><div class="pipeline-inner"><div class="pipeline-release-head"><div><div class="release-hash">${latest.commit ? `#${esc(latest.commit.slice(0, 12))}` : 'Awaiting source commit'}</div><div class="release-time">${esc(latest.source === 'webhook' ? 'Triggered by GitHub push' : 'Triggered manually')}</div></div></div>${stageMarkup(latest.stages)}<pre class="log-peek">${esc((latest.log || 'Waiting for pipeline output…').trim().split('\n').slice(-4).join('\n'))}</pre></div></section>` : ''}`;
}
function servicesView() {
  return `<div class="page-heading"><div><div class="eyebrow">YOUR DEPLOYMENT TARGETS</div><h1>Services</h1><p>Connect a Git branch to Docker Compose, Kubernetes, Helm, or a Jenkins pipeline.</p></div><button class="button button-primary" data-action="add-service">＋ New service</button></div>${state.services.length ? `<div class="service-grid">${state.services.map(s => { const latest = state.releases.find(r => r.serviceId === s.id); return `<article class="service-card"><div class="service-card-top"><div class="service-card-name"><div class="service-icon">${serviceIcon(s.name)}</div>${esc(s.name)}</div>${pill(latest?.status === 'succeeded' ? 'succeeded' : latest?.status || 'waiting')}</div><div class="service-card-detail">${esc(repoShort(s.repoUrl))}<br>${esc(s.branch)} → ${esc(serviceTarget(s))}<br>${esc(s.remotePath || s.imageRepository || '')}</div><div class="service-card-footer"><button class="text-link" data-action="service-detail" data-id="${s.id}">Configuration ↗</button><div class="service-card-actions"><button class="button mini-button" data-action="delete-service" data-id="${s.id}">Remove</button><button class="button button-primary mini-button" data-action="deploy" data-id="${s.id}" ${state.running.includes(s.id) ? 'disabled' : ''}>Deploy ↑</button></div></div></article>`; }).join('')}</div>` : `<section class="panel">${emptyState('No services connected', 'Choose Docker Compose, Kubernetes, Helm, or Jenkins when you connect a repository.')}</section>`}`;
}
function detailView(service) {
  const releases = state.releases.filter(r => r.serviceId === service.id);
  const webhook = `${location.origin}/api/webhooks/${service.id}`;
  const mode = service.deployMode === 'helm' ? 'Kubernetes with Helm' : service.deployMode === 'kubernetes' ? 'Kubernetes manifests' : service.deployMode === 'jenkins' ? 'Jenkins' : 'Docker Compose over SSH';
  const rows = [
    ['Repository', repoShort(service.repoUrl)], ['Branch', service.branch], ['Deployment method', mode], ['Target', serviceTarget(service)],
    ...(['kubernetes', 'helm'].includes(service.deployMode) ? [['Kubeconfig', service.kubeconfigPath], ['Context', service.kubeContext || 'Current context'], ...(service.deployMode === 'helm' ? [['Helm chart', service.chartPath]] : []), ['Image', service.imageRepository], ['Replicas', service.replicas], ['Public exposure', service.k8sExposure === 'ingress' ? `Ingress · ${service.ingressHost}` : service.k8sExposure === 'load-balancer' ? 'LoadBalancer' : 'Internal only'], ...(service.ingressClassName ? [['Ingress class', service.ingressClassName]] : []), ...(service.imagePullSecret ? [['Image pull secret', service.imagePullSecret]] : []), ...(service.ingressTlsSecret ? [['TLS secret', service.ingressTlsSecret]] : [])] : []),
    ...(service.deployMode === 'jenkins' ? [['Jenkins URL', service.jenkinsUrl], ['Job', service.jenkinsJob], ['Image', service.imageRepository], ['Token variable', service.jenkinsTokenEnv]] : []),
    ...(!['kubernetes', 'helm', 'jenkins'].includes(service.deployMode) ? [['App folder', service.remotePath], ['Compose file', service.composeFile], ['SSH key path', service.keyPath]] : []),
    ['Health check', `${service.healthPort}${service.healthPath}`],
  ];
  const sourcePanel = `<section class="panel"><div class="panel-head"><div><div class="panel-title">Push-to-deploy</div><div class="panel-subtitle">Verified GitHub webhook</div></div><span class="status-pill success">HMAC SIGNED</span></div><div class="webhook-panel"><p>Set this URL in GitHub → Settings → Webhooks. Choose <b>application/json</b>, the secret you saved, and the <b>push</b> event. Shipyard filters pushes to <span class="mono">${esc(service.branch)}</span>.</p><div class="copy-field" style="margin:0"><span>WEBHOOK URL</span><code id="detail-webhook-url">${esc(webhook)}</code><button class="copy-button" data-copy="detail-webhook-url">Copy</button></div><p class="muted">Rotate the webhook secret here if you lose it or suspect it was exposed. Update the GitHub webhook after rotating.</p><button class="button button-quiet" data-action="rotate-webhook" data-id="${service.id}">Rotate webhook secret</button></div></section>`;
  return `<div class="page-heading"><div><div class="eyebrow"><button class="text-link" data-view="services">← Services</button> / CONFIGURATION</div><h1>${esc(service.name)}</h1><p>${esc(mode)} · ${esc(service.branch)} branch</p></div><div class="heading-tools"><button class="button button-quiet" data-action="edit-service" data-id="${service.id}" ${state.running.includes(service.id) ? 'disabled' : ''}>Edit service</button><button class="button button-primary" data-action="deploy" data-id="${service.id}" ${state.running.includes(service.id) ? 'disabled' : ''}>Deploy now ↑</button></div></div><div class="detail-grid"><section class="panel"><div class="panel-head"><div><div class="panel-title">Service configuration</div><div class="panel-subtitle">Source and deployment target</div></div></div><div class="detail-kv">${rows.map(([label, value]) => `<span>${esc(label)}</span><code>${esc(value || '—')}</code>`).join('')}</div></section>${sourcePanel}</div><section class="panel section-block"><div class="panel-head"><div><div class="panel-title">Release history</div><div class="panel-subtitle">${releases.length} deployments</div></div></div>${releases.length ? `<div class="release-list">${releases.map(releaseRow).join('')}</div>` : '<div class="empty-inline">No releases yet. Deploy now to start the release history.</div>'}</section>`;
}
function deploymentsView() {
  return `<div class="page-heading"><div><div class="eyebrow">RELEASE HISTORY</div><h1>Deployments</h1><p>Every manual run and GitHub push, with build output and rollback status.</p></div></div><section class="panel"><div class="panel-head"><div><div class="panel-title">All releases</div><div class="panel-subtitle">${state.releases.length} deployments</div></div></div>${state.releases.length ? `<div class="release-list">${state.releases.map(releaseRow).join('')}</div>` : '<div class="empty-inline">No deployments yet. Connect a service and ship its first release.</div>'}</section>`;
}
function activityView() {
  return `<div class="page-heading"><div><div class="eyebrow">PIPELINE EVENTS</div><h1>Activity</h1><p>Recent changes across all connected services.</p></div></div><section class="panel"><div class="panel-head"><div><div class="panel-title">Event stream</div><div class="panel-subtitle">Most recent first</div></div></div><div class="activity-list">${state.events.length ? state.events.map(eventMarkup).join('') : '<div class="empty-inline">No activity to show yet.</div>'}</div></section>`;
}
function render() {
  const detail = activeView === 'detail' && selectedService && serviceFor(selectedService);
  viewRoot.innerHTML = detail ? detailView(serviceFor(selectedService)) : activeView === 'services' ? servicesView() : activeView === 'deployments' ? deploymentsView() : activeView === 'activity' ? activityView() : activeView === 'toolkit' ? window.ShipyardToolkit.render() : modernOverview();
  $$('.nav-item').forEach(x => x.classList.toggle('active', x.dataset.view === activeView || (activeView === 'detail' && x.dataset.view === 'services')));
}
async function deployService(serviceId) {
  try { await request(`/api/services/${serviceId}/deploy`, { method: 'POST' }); toast('Deployment started. Logs will appear in the pipeline.', 'success'); activeView = 'deployments'; await refresh(); }
  catch (e) { toast(e.message, 'error'); }
}
function showWebhook(service, secret) {
  $('#webhook-url').textContent = `${location.origin}/api/webhooks/${service.id}`;
  $('#webhook-secret').textContent = secret;
  webhookDialog.showModal();
}
function showLogs(releaseId) {
  const release = releaseFor(releaseId); if (!release) return;
  viewedLogId = releaseId;
  $('#log-title').textContent = `${release.serviceName} · ${release.commit ? release.commit.slice(0, 12) : 'Release logs'}`;
  $('#log-content').textContent = release.log || 'No output yet.';
  logDialog.showModal();
  $('#log-content').scrollTop = $('#log-content').scrollHeight;
}

document.addEventListener('click', async event => {
  if (!event.target.closest('.account-wrap')) closeAccountMenu();
  const navButton = event.target.closest('[data-view]');
  if (navButton) { nav(navButton.dataset.view); return; }
  const action = event.target.closest('[data-action]');
  if (action) {
    const { action: kind, id: itemId } = action.dataset;
    if (kind === 'account-menu-toggle') {
      const menu = $('#account-menu');
      menu.hidden = !menu.hidden;
      $('#account-button').setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) $('button[role="menuitem"]', menu).focus();
    }
    else if (kind === 'account-settings') {
      closeAccountMenu();
      $('#account-form-error').hidden = true;
      $('#account-name-input').value = authUser?.name || '';
      $('#account-email-value').textContent = authUser?.email || '';
      const isGoogle = authUser?.provider === 'google';
      $('#account-provider-value').textContent = isGoogle ? 'Google' : 'Email and password';
      $('#account-password-fields').hidden = isGoogle;
      $('#google-password-note').hidden = !isGoogle;
      $('#account-form').reset();
      $('#account-name-input').value = authUser?.name || '';
      $('#account-dialog').showModal();
      $('#account-name-input').focus();
    }
    else if (kind === 'workspace-settings') {
      closeAccountMenu();
      $('#workspace-form-error').hidden = true;
      $('#workspace-name-input').value = state.workspaceName || 'Shipyard workspace';
      workspaceDialog.showModal();
      $('#workspace-name-input').focus();
    }
    else if (kind === 'open-help') { closeAccountMenu(); helpDialog.showModal(); }
    else if (kind === 'add-service') openAdd();
    else if (kind === 'edit-service') {
      const service = serviceFor(itemId);
      if (service) openEdit(service);
    }
    else if (kind === 'rotate-webhook') {
      const service = serviceFor(itemId);
      if (service && confirm(`Rotate the GitHub webhook secret for ${service.name}? Push deployments will stop until you update the secret in GitHub.`)) {
        try {
          const result = await request(`/api/services/${itemId}/webhook-secret`, { method: 'POST' });
          showWebhook(service, result.webhookSecret);
        } catch (error) { toast(error.message, 'error'); }
      }
    }
    else if (kind === 'change-google-client' || kind === 'configure-google' || kind === 'google-settings') { closeAccountMenu(); openGoogleSettings(); }
    else if (kind === 'show-login') {
      if (authUser) { $('#auth-gate').hidden = true; $('.app-shell').hidden = false; refresh(); }
      else setAuthScreen('login');
    }
    else if (kind === 'show-signup') setAuthScreen('signup');
    else if (kind === 'show-forgot') {
      $('#forgot-message').hidden = true; $('#forgot-error').hidden = true;
      $('#forgot-form [name="email"]').value = $('#login-form [name="email"]').value;
      setAuthScreen('forgot');
    }
    else if (kind === 'logout') {
      closeAccountMenu();
      try { await request('/api/auth/logout', { method: 'POST' }); window.google?.accounts?.id?.disableAutoSelect?.(); }
      finally { authUser = null; await boot(); }
    }
    else if (kind === 'close-dialog') serviceDialog.close();
    else if (kind === 'close-webhook') webhookDialog.close();
    else if (kind === 'close-logs') logDialog.close();
    else if (kind === 'close-account') accountDialog.close();
    else if (kind === 'close-workspace') workspaceDialog.close();
    else if (kind === 'close-help') helpDialog.close();
    else if (kind === 'download-backup') {
      try {
        const response = await fetch('/api/backup');
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          throw new Error(result.error || `Backup failed (${response.status}).`);
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `shipyard-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast('Workspace backup downloaded. Keep it private.', 'success');
      } catch (error) { toast(error.message, 'error'); }
    }
    else if (kind === 'deploy') deployService(itemId);
    else if (kind === 'logs') showLogs(itemId);
    else if (kind === 'service-detail') { selectedService = itemId; activeView = 'detail'; render(); }
    else if (kind === 'delete-service') {
      const service = serviceFor(itemId);
      if (service && confirm(`Remove ${service.name} from Shipyard? This will not remove anything from the server.`)) {
        try { await request(`/api/services/${itemId}`, { method: 'DELETE' }); toast('Service removed.', 'success'); await refresh(); }
        catch (e) { toast(e.message, 'error'); }
      }
    }
    return;
  }
  const copy = event.target.closest('[data-copy]');
  if (copy) {
    const target = document.getElementById(copy.dataset.copy);
    if (target) { await navigator.clipboard.writeText(target.textContent); const old = copy.textContent; copy.textContent = 'Copied'; setTimeout(() => copy.textContent = old, 1200); }
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#account-menu').hidden) {
    closeAccountMenu();
    $('#account-button').focus();
    return;
  }
  if ($('.app-shell').hidden) return;
  if (event.defaultPrevented || event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  if (event.key === '?' && ![serviceDialog, webhookDialog, logDialog, accountDialog, workspaceDialog, helpDialog].some(dialog => dialog.open)) {
    event.preventDefault();
    helpDialog.showModal();
    return;
  }
  if (event.altKey && event.shiftKey && /^[1-5]$/.test(event.key) && !event.ctrlKey && !event.metaKey) {
    const view = ['overview', 'services', 'deployments', 'activity', 'toolkit'][Number(event.key) - 1];
    event.preventDefault();
    nav(view);
  }
});

$('#account-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = $('#account-form-error');
  const button = $('button[type="submit"]', form);
  errorBox.hidden = true;
  const currentPassword = form.elements.currentPassword?.value || '';
  const newPassword = form.elements.newPassword?.value || '';
  const confirmPassword = form.elements.confirmPassword?.value || '';
  if ((currentPassword || newPassword || confirmPassword) && (!currentPassword || !newPassword || !confirmPassword)) {
    errorBox.textContent = 'Enter your current password, new password, and confirmation to change your password.';
    errorBox.hidden = false;
    return;
  }
  if (newPassword && newPassword !== confirmPassword) {
    errorBox.textContent = 'The new password and confirmation do not match.';
    errorBox.hidden = false;
    return;
  }
  button.disabled = true;
  try {
    const result = await request('/api/auth/account', {
      method: 'POST',
      body: JSON.stringify({ name: form.elements.name.value, currentPassword, newPassword }),
    });
    authUser = result.user;
    const initial = (authUser.name || authUser.email || 'S').trim().slice(0, 1).toUpperCase();
    $('#account-button').textContent = initial;
    $('#account-button').title = `${authUser.email || 'Signed in'} · Account menu`;
    $('#account-name').textContent = authUser.name || 'Account';
    $('#account-email').textContent = authUser.email || '';
    accountDialog.close();
    toast('Account settings saved.', 'success');
  } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
  finally { button.disabled = false; }
});

$('#workspace-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = $('#workspace-form-error');
  const button = $('button[type="submit"]', form);
  errorBox.hidden = true;
  button.disabled = true;
  try {
    const result = await request('/api/workspace', { method: 'POST', body: JSON.stringify({ name: form.elements.name.value }) });
    state.workspaceName = result.workspaceName;
    $('#workspace-menu-name').textContent = `Workspace · ${result.workspaceName}`;
    workspaceDialog.close();
    toast('Workspace name saved.', 'success');
  } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
  finally { button.disabled = false; }
});

$('#service-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('button[type="submit"]', event.currentTarget);
  const errorBox = $('#form-error');
  errorBox.hidden = true;
  button.disabled = true;
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  const serviceId = editingServiceId;
  if (serviceId) payload.deployMode = serviceFor(serviceId)?.deployMode || 'compose-ssh';
  try {
    const result = await request(serviceId ? `/api/services/${serviceId}` : '/api/services', {
      method: serviceId ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    serviceDialog.close();
    if (serviceId) {
      editingServiceId = null;
      activeView = 'detail';
      selectedService = serviceId;
    } else activeView = 'services';
    await refresh();
    if (serviceId) toast('Service configuration saved.', 'success');
    else showWebhook(result.service, result.webhookSecret);
  } catch (e) { errorBox.textContent = e.message; errorBox.hidden = false; }
  finally { button.disabled = false; }
});
$('#service-form').addEventListener('change', event => {
  if (['deployMode', 'k8sExposure'].includes(event.target.name)) syncTargetFields();
});

$('#client-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('button[type="submit"]', event.currentTarget);
  const errorBox = $('#client-error');
  errorBox.hidden = true;
  button.disabled = true;
  try {
    await request('/api/auth/config', { method: 'POST', body: JSON.stringify({ clientId: $('#client-id-input').value.trim() }) });
    location.reload();
  } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
  finally { button.disabled = false; }
});

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  const errorBox = $('#login-error');
  errorBox.hidden = true;
  button.disabled = true;
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    const result = await request('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
    enterApp(result.user);
  } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
  finally { button.disabled = false; }
});

$('#signup-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  const errorBox = $('#signup-error');
  errorBox.hidden = true;
  button.disabled = true;
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    const result = await request('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) });
    enterApp(result.user);
  } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
  finally { button.disabled = false; }
});

$('#forgot-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  $('#forgot-error').hidden = true;
  $('#forgot-message').hidden = true;
  button.disabled = true;
  try {
    await request('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ email: new FormData(form).get('email') }) });
    const delivery = authConfig?.passwordResetDelivery;
    $('#forgot-message').textContent = delivery === 'email'
      ? 'If that email has a Shipyard password account, a reset link will arrive by email. It expires in 20 minutes.'
      : delivery === 'server-console'
        ? 'If that email has a Shipyard password account, a one-time reset link is in the Shipyard server window. It expires in 20 minutes.'
        : 'Password reset email delivery is not configured. Ask the Shipyard administrator for help.';
    $('#forgot-message').hidden = false;
  } catch (error) { $('#forgot-error').textContent = error.message; $('#forgot-error').hidden = false; }
  finally { button.disabled = false; }
});

$('#reset-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  const errorBox = $('#reset-error');
  errorBox.hidden = true;
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form).entries());
  try {
    if (values.password !== values.confirm) throw new Error('The passwords do not match.');
    await request('/api/auth/reset', { method: 'POST', body: JSON.stringify({ token: resetToken, password: values.password }) });
    resetToken = '';
    history.replaceState(null, '', location.pathname);
    form.reset();
    setAuthScreen('login');
    $('#login-error').hidden = true;
    toast('Password updated. Sign in with your new password.', 'success');
  } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
  finally { button.disabled = false; }
});

boot();
setInterval(() => { if (authUser) refresh(); }, 3000);
}
