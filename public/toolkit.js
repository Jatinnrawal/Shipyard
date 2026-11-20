(() => {
  const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const slug = value => String(value || 'my-app').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'my-app';
  const state = { runtime: 'node', name: '', port: '', healthPath: '', replicas: '', exposure: 'internal', ingressHost: '', ingressClassName: '', ingressTlsSecret: '', imagePullSecret: '', activeFile: 0, files: [] };
  let capabilities = null;
  let capabilityLoading = false;

  function loadCapabilities() {
    if (capabilities || capabilityLoading) return;
    capabilityLoading = true;
    fetch('/api/capabilities').then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not read local tool status.');
      capabilities = body;
    }).catch(error => { capabilities = { error: error.message }; }).finally(() => {
      capabilityLoading = false;
      const list = document.querySelector('#view [data-capability-list]');
      if (list) list.innerHTML = capabilityMarkup();
    });
  }
  function capabilityMarkup() {
    if (!capabilities) return '<div class="capability-loading">Checking tools installed on this Shipyard host…</div>';
    if (capabilities.error) return '<div class="capability-loading">' + esc(capabilities.error) + '</div>';
    const tools = (capabilities.tools || []).map(tool => {
      const status = tool.ready ? 'ready' : tool.installed ? 'setup' : 'missing';
      const label = tool.name === 'kubectl' ? 'Kubernetes cluster' : tool.name === 'docker' ? 'Docker Engine' : tool.name;
      const stateLabel = tool.ready ? 'READY' : tool.installed ? 'SETUP NEEDED' : 'NOT INSTALLED';
      return '<div class="capability-item"><span class="capability-state ' + status + '"></span><div><b>' + esc(label) + '</b><small>' + esc(tool.detail) + '</small></div><strong>' + stateLabel + '</strong></div>';
    });
    tools.push('<div class="capability-item"><span class="capability-state ' + (capabilities.jenkinsTokenAvailable ? 'ready' : 'setup') + '"></span><div><b>Jenkins API token</b><small>' + (capabilities.jenkinsTokenAvailable ? 'Environment variable is set' : 'Set the token variable when you connect a Jenkins target') + '</small></div><strong>' + (capabilities.jenkinsTokenAvailable ? 'READY' : 'OPTIONAL') + '</strong></div>');
    return tools.join('');
  }

  function makeFiles(config) {
    const name = slug(config.name);
    const isStatic = config.runtime === 'static';
    const isPython = config.runtime === 'python';
    const port = isStatic ? 8080 : Number(config.port) || 8080;
    const publicPort = Number(config.port) || 8080;
    const rawHealthPath = String(config.healthPath || '/');
    const healthPath = isStatic ? '/' : /^\/[A-Za-z0-9/_-]*$/.test(rawHealthPath) ? rawHealthPath : '/';
    const replicas = Math.min(20, Math.max(1, Number(config.replicas) || 1));
    const exposure = ['internal', 'load-balancer', 'ingress'].includes(config.exposure) ? config.exposure : 'internal';
    const ingressHost = String(config.ingressHost || '').trim().toLowerCase();
    const ingressClassName = String(config.ingressClassName || '').trim();
    const ingressTlsSecret = String(config.ingressTlsSecret || '').trim();
    const imagePullSecret = String(config.imagePullSecret || '').trim();
    const dockerfile = isStatic
      ? ['FROM nginx/nginx-unprivileged:1-alpine', 'COPY . /usr/share/nginx/html', 'EXPOSE 8080', ''].join('\n')
      : isPython
        ? ['FROM python:3.12-slim', 'ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1', 'RUN useradd --create-home --uid 10001 app', 'WORKDIR /app', 'COPY --chown=app:app . .', 'RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi', 'USER 10001:10001', 'EXPOSE ' + port, 'CMD ["python", "app.py"]', ''].join('\n')
        : ['FROM node:22-alpine', 'ENV NODE_ENV=production', 'RUN mkdir -p /app && chown node:node /app', 'USER node', 'WORKDIR /app', 'COPY --chown=node:node package*.json ./', 'RUN npm ci --omit=dev', 'COPY --chown=node:node . .', 'EXPOSE ' + port, 'CMD ["npm", "start"]', ''].join('\n');
    const compose = [
      'services:', '  ' + name + ':', '    build:', '      context: .', '      dockerfile: Dockerfile',
      '    image: shipyard/' + name + ':local', '    ports:', '      - "' + publicPort + ':' + port + '"',
      '    restart: unless-stopped', '    init: true', '',
    ].join('\n');
    const deployment = [
      'apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: ' + name, '  labels:',
      '    app.kubernetes.io/name: ' + name, 'spec:', '  replicas: ' + replicas, '  selector:',
      '    matchLabels:', '      app.kubernetes.io/name: ' + name, '  template:', '    metadata:',
      '      labels:', '        app.kubernetes.io/name: ' + name, '    spec:', '      securityContext:',
      '        runAsNonRoot: true', '        seccompProfile:', '          type: RuntimeDefault', '      containers:',
      '        - name: ' + name, '          image: ghcr.io/your-org/' + name + ':latest',
      '          imagePullPolicy: Always', '          ports:', '            - name: http',
      '              containerPort: ' + port, '              protocol: TCP', '          readinessProbe:',
      '            httpGet:', '              path: ' + healthPath, '              port: http',
      '            initialDelaySeconds: 5', '            periodSeconds: 10', '          livenessProbe:',
      '            httpGet:', '              path: ' + healthPath, '              port: http',
      '            initialDelaySeconds: 15', '            periodSeconds: 20', '          securityContext:',
      '            allowPrivilegeEscalation: false', '            capabilities:', '              drop: ["ALL"]', '          resources:',
      '            requests:', '              cpu: 100m', '              memory: 128Mi', '            limits:',
      '              cpu: 500m', '              memory: 512Mi', '',
    ].join('\n');
    const deploymentWithPullSecret = imagePullSecret
      ? deployment.replace('      containers:\n', '      imagePullSecrets:\n        - name: ' + JSON.stringify(imagePullSecret) + '\n      containers:\n')
      : deployment;
    const serviceType = exposure === 'load-balancer' ? 'LoadBalancer' : 'ClusterIP';
    const service = [
      'apiVersion: v1', 'kind: Service', 'metadata:', '  name: ' + name, 'spec:',
      '  type: ' + serviceType, '  selector:', '    app.kubernetes.io/name: ' + name, '  ports:',
      '    - name: http', '      port: ' + publicPort, '      targetPort: ' + port, '      protocol: TCP', '',
    ].join('\n');
    const ingress = [
      'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: ' + name, 'spec:',
      ...(ingressClassName ? ['  ingressClassName: ' + JSON.stringify(ingressClassName)] : []),
      ...(ingressTlsSecret ? ['  tls:', '    - hosts:', '        - ' + JSON.stringify(ingressHost), '      secretName: ' + JSON.stringify(ingressTlsSecret)] : []),
      '  rules:', '    - host: ' + JSON.stringify(ingressHost), '      http:', '        paths:', '          - path: /',
      '            pathType: Prefix', '            backend:', '              service:', '                name: ' + name,
      '                port:', '                  name: http', '',
    ].join('\n');
    const chart = ['apiVersion: v2', 'name: ' + name, 'description: Helm chart generated by Shipyard', 'type: application', 'version: 0.1.0', 'appVersion: "1.0.0"', ''].join('\n');
    const values = [
      'replicaCount: ' + replicas, '', 'image:', '  repository: ghcr.io/your-org/' + name,
      '  pullPolicy: IfNotPresent', '  tag: latest', '',
      'imagePullSecrets:' + (imagePullSecret ? '\n  - name: ' + JSON.stringify(imagePullSecret) : ' []'), '',
      'service:', '  type: ' + serviceType,
      '  port: ' + publicPort, '', 'containerPort: ' + port, 'healthPath: ' + healthPath, '',
      'ingress:', '  enabled: ' + (exposure === 'ingress'), '  className: ' + JSON.stringify(ingressClassName),
      '  hosts:', '    - host: ' + JSON.stringify(ingressHost), '      paths:', '        - path: /', '          pathType: Prefix',
      '  tls:', ...(ingressTlsSecret ? ['    - secretName: ' + JSON.stringify(ingressTlsSecret), '      hosts:', '        - ' + JSON.stringify(ingressHost)] : ['    []']), '',
      'resources:', '  requests:', '    cpu: 100m', '    memory: 128Mi', '  limits:',
      '    cpu: 500m', '    memory: 512Mi', '',
    ].join('\n');
    const helmDeployment = [
      'apiVersion: apps/v1', 'kind: Deployment', 'metadata:',
      '  name: {{ include "' + name + '.fullname" . }}', '  labels:',
      '    app.kubernetes.io/name: {{ include "' + name + '.name" . }}', 'spec:',
      '  replicas: {{ .Values.replicaCount }}', '  selector:', '    matchLabels:',
      '      app.kubernetes.io/name: {{ include "' + name + '.name" . }}', '  template:',
      '    metadata:', '      labels:', '        app.kubernetes.io/name: {{ include "' + name + '.name" . }}',
      '    spec:', '      {{- with .Values.imagePullSecrets }}', '      imagePullSecrets:', '        {{- toYaml . | nindent 8 }}', '      {{- end }}',
      '      securityContext:', '        runAsNonRoot: true', '        seccompProfile:', '          type: RuntimeDefault', '      containers:', '        - name: ' + name,
      '          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"',
      '          imagePullPolicy: {{ .Values.image.pullPolicy }}', '          ports:',
      '            - name: http', '              containerPort: {{ .Values.containerPort }}',
      '          readinessProbe:', '            httpGet:', '              path: {{ .Values.healthPath }}',
      '              port: http', '          livenessProbe:', '            httpGet:',
      '              path: {{ .Values.healthPath }}', '              port: http', '          securityContext:',
      '            allowPrivilegeEscalation: false', '            capabilities:', '              drop: ["ALL"]', '          resources:',
      '            {{- toYaml .Values.resources | nindent 12 }}', '',
    ].join('\n');
    const helmService = [
      'apiVersion: v1', 'kind: Service', 'metadata:', '  name: {{ include "' + name + '.fullname" . }}',
      'spec:', '  type: {{ .Values.service.type }}', '  selector:',
      '    app.kubernetes.io/name: {{ include "' + name + '.name" . }}', '  ports:', '    - name: http',
      '      port: {{ .Values.service.port }}', '      targetPort: {{ .Values.containerPort }}', '',
    ].join('\n');
    const helmIngress = [
      '{{- if .Values.ingress.enabled }}', 'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:',
      '  name: {{ include "' + name + '.fullname" . }}', '  labels:', '    app.kubernetes.io/name: {{ include "' + name + '.name" . }}',
      'spec:', '  {{- with .Values.ingress.className }}', '  ingressClassName: {{ . | quote }}', '  {{- end }}',
      '  {{- with .Values.ingress.tls }}', '  tls:', '    {{- toYaml . | nindent 4 }}', '  {{- end }}',
      '  rules:', '    {{- range .Values.ingress.hosts }}', '    - host: {{ .host | quote }}', '      http:', '        paths:',
      '          {{- range .paths }}', '          - path: {{ .path }}', '            pathType: {{ .pathType }}', '            backend:',
      '              service:', '                name: {{ include "' + name + '.fullname" $ }}', '                port:',
      '                  name: http', '          {{- end }}', '    {{- end }}', '{{- end }}', '',
    ].join('\n');
    const helpers = [
      '{{- define "' + name + '.name" -}}',
      '{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}',
      '{{- end -}}', '{{- define "' + name + '.fullname" -}}',
      '{{- default (printf "%s-%s" .Release.Name (include "' + name + '.name" .)) .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}',
      '{{- end -}}', '',
    ].join('\n');
    const runtimeName = isStatic ? 'Static site' : isPython ? 'Python' : 'Node.js';
    const jenkins = [
      'pipeline {', '  agent any', '  options { timestamps(); disableConcurrentBuilds() }', '  parameters {',
      "    string(name: 'IMAGE_REPOSITORY', defaultValue: 'ghcr.io/your-org/" + name + "', description: 'Image repository without a tag')",
      "    string(name: 'KUBE_NAMESPACE', defaultValue: 'default', description: 'Kubernetes namespace')", '  }',
      '  environment {', "    APP_NAME = '" + name + "'", "    APP_RUNTIME = '" + config.runtime + "'",
      "    REGISTRY_HOST = 'ghcr.io'", '  }', '  stages {',
      "    stage('Checkout') { steps { checkout scm } }", "    stage('Checks') {", '      steps {',
      "        sh '''case \"$APP_RUNTIME\" in", '          node)', '            npm ci',
      "            if node -e \"const p=require('./package.json');process.exit(p.scripts&&p.scripts.test?0:1)\"; then npm test; else echo \"No test script found; skipped.\"; fi",
      '            ;;', '          python)', '            if [ -f requirements.txt ]; then python -m pip install -r requirements.txt; fi',
      '            python -m compileall -q .', '            ;;', '          static) test -f index.html ;;', "        esac'''", '      }', '    }',
      "    stage('Build image') {", '      steps { sh \'docker build -t \"$IMAGE_REPOSITORY:$BUILD_NUMBER\" .\' }', '    }',
      "    stage('Push image') {", '      steps {',
      "        withCredentials([usernamePassword(credentialsId: 'container-registry', usernameVariable: 'REGISTRY_USER', passwordVariable: 'REGISTRY_TOKEN')]) {",
      "          sh '''printf \"%s\" \"$REGISTRY_TOKEN\" | docker login \"$REGISTRY_HOST\" --username \"$REGISTRY_USER\" --password-stdin",
      'docker push \"$IMAGE_REPOSITORY:$BUILD_NUMBER\"\'\'\'', '        }', '      }', '    }',
      "    stage('Deploy to Kubernetes') {", '      steps {', "        sh '''kubectl apply --namespace \"$KUBE_NAMESPACE\" -f k8s/",
      'kubectl set image --namespace \"$KUBE_NAMESPACE\" deployment/\"$APP_NAME\" \"$APP_NAME\"=\"$IMAGE_REPOSITORY:$BUILD_NUMBER\"',
      'kubectl rollout status --namespace \"$KUBE_NAMESPACE\" deployment/\"$APP_NAME\" --timeout=180s\'\'\'',
      '      }', '    }', '  }', "  post { always { sh 'docker logout \"$REGISTRY_HOST\" || true' } }", '}', '',
    ].join('\n');
    const githubActions = [
      'name: Shipyard CI', 'on:', '  push:', '  pull_request:', '',
      'permissions:', '  contents: read', '', 'jobs:', '  checks:',
      '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v7',
      ...(isPython ? [
        '      - uses: actions/setup-python@v7', '        with:', '          python-version: "3.12"',
        '      - name: Install and check', '        run: |',
        '          if [ -f requirements.txt ]; then pip install -r requirements.txt; fi',
        '          python -m compileall -q .',
      ] : isStatic ? [
        '      - name: Check site entry point', '        run: test -f index.html',
      ] : [
        '      - uses: actions/setup-node@v7', '        with:', '          node-version: "22"', '          cache: npm',
        '      - name: Install dependencies', '        run: npm ci',
        '      - name: Run tests', '        run: npm test --if-present',
      ]),
      '  publish-image:', '    if: github.event_name == \'push\'', '    needs: checks',
      '    permissions:', '      contents: read', '      packages: write',
      '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v7',
      '      - name: Set lower-case image name', '        id: image', '        run: echo "name=ghcr.io/${GITHUB_REPOSITORY,,}" >> "$GITHUB_OUTPUT"',
      '      - uses: docker/setup-buildx-action@v4',
      '      - name: Sign in to GitHub Container Registry', '        uses: docker/login-action@v4', '        with:',
      '          registry: ghcr.io', '          username: ${{ github.actor }}', '          password: ${{ secrets.GITHUB_TOKEN }}',
      '      - name: Build and publish', '        uses: docker/build-push-action@v7', '        with:',
      '          context: .', '          push: true', '          tags: ${{ steps.image.outputs.name }}:${{ github.sha }}',
      '          cache-from: type=gha', '          cache-to: type=gha,mode=max', '          provenance: mode=min', '          sbom: true', '',
    ].join('\n');
    const dockerignore = [
      '.git', '.env', '.env.*', 'node_modules', '__pycache__', '*.pyc', '.venv', 'coverage', '*.log',
      'Dockerfile', '.dockerignore', 'compose.yaml', 'Jenkinsfile', '.github/', 'k8s/', 'helm/', 'README-DEVOPS.md',
      '',
    ].join('\n');
    const checks = isPython
      ? 'install requirements.txt when present, then run python -m compileall -q .'
      : isStatic ? 'confirm index.html exists and review generated assets.' : 'run npm ci, then npm test when a test script exists.';
    const readme = [
      '# ' + name + ' deployment kit', '', 'Generated starter files for a ' + runtimeName + ' project.', '',
      '## Docker Compose', '', 'Review the Dockerfile and ports, then run: docker compose up --build.', '',
      '## Kubernetes', '', 'Set the image in k8s/deployment.yaml, connect kubectl to your cluster, then apply k8s/.',
      exposure === 'load-balancer' ? 'The Service uses type LoadBalancer; your cluster or cloud provider must provision the external address.' : exposure === 'ingress' ? 'k8s/ingress.yaml routes ' + ingressHost + ' through an installed ingress controller. Point DNS at that controller. The referenced TLS Secret must already exist in the namespace.' : 'The Service is ClusterIP and internal only. Change its type or configure an Ingress when you are ready to expose the app.',
      imagePullSecret ? 'The Deployment references the existing image pull Secret ' + imagePullSecret + ' in the target namespace.' : 'For a private image, create a registry pull Secret in the target namespace and add its name under imagePullSecrets.',
      'Verify that the health endpoint responds at ' + healthPath + ' before using the generated probes.', '',
      '## Helm', '', 'Update the image repository in helm/' + name + '/values.yaml, then install with Helm.', '',
      '## Jenkins', '', 'Create a Pipeline job from this repository. Add Jenkins credentials with ID container-registry for GHCR.',
      'Install Docker and kubectl on the Jenkins agent. Give the agent a kubeconfig restricted to the target namespace.',
      'The generated check stage will ' + checks, 'Set IMAGE_REPOSITORY and KUBE_NAMESPACE when starting a build.', '',
      '## Adjust for your project', '',
      (isPython ? 'The Python image expects app.py and optionally requirements.txt.' : isStatic ? 'The static image expects index.html and copies files into Nginx.' : 'The Node image expects package-lock.json and an npm start script.'),
      'The GitHub workflow reuses BuildKit cache and attaches a software bill of materials (SBOM) plus minimal build provenance to published images.',
      'Review generated config before production use. Keep secrets in Jenkins or your cluster secret manager, never in Git.', '',
    ].join('\n');
    return [
      { path: 'Dockerfile', content: dockerfile },
      { path: '.dockerignore', content: dockerignore },
      { path: 'compose.yaml', content: compose },
      { path: '.github/workflows/shipyard.yml', content: githubActions },
      { path: 'Jenkinsfile', content: jenkins },
      { path: 'k8s/deployment.yaml', content: deploymentWithPullSecret },
      { path: 'k8s/service.yaml', content: service },
      ...(exposure === 'ingress' ? [{ path: 'k8s/ingress.yaml', content: ingress }] : []),
      { path: 'helm/' + name + '/Chart.yaml', content: chart },
      { path: 'helm/' + name + '/values.yaml', content: values },
      { path: 'helm/' + name + '/templates/_helpers.tpl', content: helpers },
      { path: 'helm/' + name + '/templates/deployment.yaml', content: helmDeployment },
      { path: 'helm/' + name + '/templates/service.yaml', content: helmService },
      { path: 'helm/' + name + '/templates/ingress.yaml', content: helmIngress },
      { path: 'README-DEVOPS.md', content: readme },
    ];
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function u16(view, offset, value) { view.setUint16(offset, value, true); }
  function u32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }
  function zipFiles(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const date = new Date();
    const timeBits = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dateBits = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    for (const file of files) {
      const name = encoder.encode(file.path);
      const data = encoder.encode(file.content);
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      u32(lv, 0, 0x04034b50); u16(lv, 4, 20); u16(lv, 6, 0x0800); u16(lv, 8, 0);
      u16(lv, 10, timeBits); u16(lv, 12, dateBits); u32(lv, 14, crc); u32(lv, 18, data.length);
      u32(lv, 22, data.length); u16(lv, 26, name.length); u16(lv, 28, 0); local.set(name, 30);
      localParts.push(local, data);
      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      u32(cv, 0, 0x02014b50); u16(cv, 4, 20); u16(cv, 6, 20); u16(cv, 8, 0x0800); u16(cv, 10, 0);
      u16(cv, 12, timeBits); u16(cv, 14, dateBits); u32(cv, 16, crc); u32(cv, 20, data.length);
      u32(cv, 24, data.length); u16(cv, 28, name.length); u16(cv, 30, 0); u16(cv, 32, 0);
      u16(cv, 34, 0); u16(cv, 36, 0); u32(cv, 38, 0); u32(cv, 42, offset); central.set(name, 46);
      centralParts.push(central); offset += local.length + data.length;
    }
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    u32(ev, 0, 0x06054b50); u16(ev, 4, 0); u16(ev, 6, 0); u16(ev, 8, files.length); u16(ev, 10, files.length);
    u32(ev, 12, centralSize); u32(ev, 16, offset); u16(ev, 20, 0);
    const parts = localParts.concat(centralParts, [end]);
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let cursor = 0;
    for (const part of parts) { result.set(part, cursor); cursor += part.length; }
    return result;
  }
  function download() {
    const blob = new Blob([zipFiles(state.files)], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = slug(state.name) + '-devops-kit.zip';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function rememberForm(form) {
    if (!form || form.id !== 'toolkit-form') return;
    const values = Object.fromEntries(new FormData(form).entries());
    state.runtime = values.runtime || state.runtime;
    state.name = values.name ?? state.name;
    state.port = values.port ?? state.port;
    state.healthPath = values.healthPath ?? state.healthPath;
    state.replicas = values.replicas ?? state.replicas;
    state.exposure = values.exposure || state.exposure;
    state.imagePullSecret = values.imagePullSecret ?? state.imagePullSecret;
    if (state.exposure === 'ingress') {
      state.ingressHost = values.ingressHost ?? state.ingressHost;
      state.ingressClassName = values.ingressClassName ?? state.ingressClassName;
      state.ingressTlsSecret = values.ingressTlsSecret ?? state.ingressTlsSecret;
    }
  }
  function render() {
    rememberForm(document.querySelector('#toolkit-form'));
    if (!capabilities && !capabilityLoading) loadCapabilities();
    state.files = makeFiles(state);
    const current = state.files[Math.min(state.activeFile, state.files.length - 1)];
    const tabs = state.files.map((file, index) => '<button type="button" class="toolkit-file-tab ' + (index === state.activeFile ? 'active' : '') + '" data-action="toolkit-file" data-index="' + index + '">' + esc(file.path) + '</button>').join('');
    return [
      '<div data-toolkit-root class="page-heading"><div><div class="eyebrow">DEVOPS CONTROL PLANE</div><h1>DevOps toolkit</h1><p>Build and deploy with Docker, Kubernetes, Helm, or Jenkins. Shipyard checks the tools available on its host.</p></div><button class="button button-dark" data-action="toolkit-download">Download bundle ↓</button></div>',
      '<section class="panel toolkit-capabilities"><div class="panel-head"><div><div class="panel-title">Host tool readiness</div><div class="panel-subtitle">Live checks from this Shipyard host · no secrets are displayed</div></div></div><div class="capability-list" data-capability-list>' + capabilityMarkup() + '</div><div class="toolkit-capability-note">Kubernetes needs a reachable cluster in the kubeconfig you select. Helm is required for direct Helm deployments; choose Kubernetes manifests to deploy without a chart. Docker, kubectl, and Git are separate tools; Jenkins is a remote service.</div></section>',
      '<div class="toolkit-grid"><section class="panel toolkit-settings"><div class="panel-head"><div><div class="panel-title">Project setup</div><div class="panel-subtitle">Choose an application stack</div></div></div>',
      '<form id="toolkit-form" class="toolkit-form">',
      '<label>Application type<select name="runtime"><option value="node" ' + (state.runtime === 'node' ? 'selected' : '') + '>Node.js</option><option value="python" ' + (state.runtime === 'python' ? 'selected' : '') + '>Python</option><option value="static" ' + (state.runtime === 'static' ? 'selected' : '') + '>Static website</option></select></label>',
      '<label>Project name<input name="name" value="' + esc(state.name) + '" maxlength="48" required></label>',
      '<label>Public port<input name="port" type="number" min="1" max="65535" value="' + state.port + '" required></label>',
      '<label>Health path<input name="healthPath" value="' + esc(state.healthPath) + '" required></label>',
      '<label>Replicas<input name="replicas" type="number" min="1" max="20" value="' + state.replicas + '" required></label>',
      '<label>Public exposure<select name="exposure"><option value="internal" ' + (state.exposure === 'internal' ? 'selected' : '') + '>Internal only</option><option value="load-balancer" ' + (state.exposure === 'load-balancer' ? 'selected' : '') + '>LoadBalancer service</option><option value="ingress" ' + (state.exposure === 'ingress' ? 'selected' : '') + '>Ingress hostname</option></select></label>',
      '<label>Image pull Secret<input name="imagePullSecret" value="' + esc(state.imagePullSecret) + '" maxlength="63"><small>Existing Docker registry Secret name, if the cluster needs credentials.</small></label>',
      '<div class="toolkit-ingress-fields" data-toolkit-ingress ' + (state.exposure === 'ingress' ? '' : 'hidden') + '>',
      '<label>Ingress hostname<input name="ingressHost" value="' + esc(state.ingressHost) + '" placeholder="app.example.com" maxlength="253" ' + (state.exposure === 'ingress' ? 'required' : 'disabled') + '><small>Point DNS at the ingress controller.</small></label>',
      '<label>Ingress class<input name="ingressClassName" value="' + esc(state.ingressClassName) + '" placeholder="nginx" maxlength="253" ' + (state.exposure === 'ingress' ? '' : 'disabled') + '></label>',
      '<label>TLS Secret<input name="ingressTlsSecret" value="' + esc(state.ingressTlsSecret) + '" placeholder="app-example-com-tls" maxlength="63" ' + (state.exposure === 'ingress' ? '' : 'disabled') + '><small>Optional existing kubernetes.io/tls Secret.</small></label>',
      '</div>',
      '<button class="button button-dark toolkit-generate" type="submit">Generate files</button></form>',
      '<div class="toolkit-error" data-toolkit-error hidden></div>',
      '<div class="toolkit-note">Generated bundle includes CI, image publishing, Docker Compose, Kubernetes, Helm, Jenkins, and the selected public exposure. Review app commands, registry access, credentials, and cluster settings before deploying.</div></section>',
      '<section class="panel toolkit-preview"><div class="panel-head"><div><div class="panel-title">Generated files</div><div class="panel-subtitle">' + state.files.length + ' files ready · preview before downloading</div></div></div>',
      '<div class="toolkit-file-list">' + tabs + '</div><div class="toolkit-code-wrap"><div class="toolkit-code-title">' + esc(current.path) + '<button class="text-link" data-action="toolkit-copy">Copy</button></div><pre class="toolkit-code"><code>' + esc(current.content) + '</code></pre></div></section></div>',
    ].join('');
  }
  document.addEventListener('change', event => {
    if (event.target.form?.id !== 'toolkit-form') return;
    if (event.target.name === 'exposure') {
      const ingress = event.target.value === 'ingress';
      const fields = document.querySelector('[data-toolkit-ingress]');
      fields.hidden = !ingress;
      for (const input of fields.querySelectorAll('input')) {
        input.disabled = !ingress;
        input.required = ingress && input.name === 'ingressHost';
      }
    }
    rememberForm(event.target.form);
  });
  document.addEventListener('input', event => {
    if (event.target.form?.id === 'toolkit-form') rememberForm(event.target.form);
  });
  document.addEventListener('submit', event => {
    if (event.target.id !== 'toolkit-form') return;
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target).entries());
    const exposure = values.exposure || 'internal';
    const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    const dnsName = value => value.length <= 253 && value.split('.').every(label => dnsLabel.test(label));
    const error = document.querySelector('[data-toolkit-error]');
    const invalid = values.imagePullSecret && !dnsLabel.test(values.imagePullSecret) ? 'Image pull Secret must be a Kubernetes DNS label.'
      : exposure === 'ingress' && !dnsName(String(values.ingressHost || '').trim().toLowerCase()) ? 'Enter an Ingress hostname such as app.example.com.'
        : exposure === 'ingress' && values.ingressClassName && !dnsName(values.ingressClassName.trim()) ? 'Ingress class must be a valid Kubernetes DNS name.'
          : exposure === 'ingress' && values.ingressTlsSecret && !dnsLabel.test(values.ingressTlsSecret) ? 'TLS Secret must be a Kubernetes DNS label.' : '';
    if (invalid) { error.textContent = invalid; error.hidden = false; return; }
    error.hidden = true;
    state.runtime = values.runtime; state.name = slug(values.name);
    state.port = Math.min(65535, Math.max(1, Number(values.port) || 8080));
    const rawHealthPath = String(values.healthPath || '/');
    state.healthPath = state.runtime === 'static' ? '/' : /^\/[A-Za-z0-9/_-]*$/.test(rawHealthPath) ? rawHealthPath : '/';
    state.replicas = Math.min(20, Math.max(1, Number(values.replicas) || 1));
    state.exposure = exposure;
    state.imagePullSecret = String(values.imagePullSecret || '').trim();
    state.ingressHost = exposure === 'ingress' ? String(values.ingressHost || '').trim().toLowerCase() : '';
    state.ingressClassName = exposure === 'ingress' ? String(values.ingressClassName || '').trim() : '';
    state.ingressTlsSecret = exposure === 'ingress' ? String(values.ingressTlsSecret || '').trim() : '';
    state.activeFile = 0;
    document.querySelector('#view').innerHTML = render();
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    if (button.dataset.action === 'toolkit-download') { event.preventDefault(); download(); }
    else if (button.dataset.action === 'toolkit-file') {
      event.preventDefault(); state.activeFile = Number(button.dataset.index) || 0;
      document.querySelector('#view').innerHTML = render();
    } else if (button.dataset.action === 'toolkit-copy') {
      event.preventDefault(); await navigator.clipboard.writeText(state.files[state.activeFile].content);
      button.textContent = 'Copied'; setTimeout(() => { if (button.isConnected) button.textContent = 'Copy'; }, 1200);
    }
  });
  window.ShipyardToolkit = {
    render,
    generateFiles: config => makeFiles({ ...state, ...config }),
    zipFiles: files => zipFiles(files),
  };
})();
