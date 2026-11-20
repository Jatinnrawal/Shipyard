# Shipyard

Shipyard is a self-hosted release control plane. Connect a Git branch to Docker Compose over SSH, Kubernetes manifests, Helm, or Jenkins. Start releases from the dashboard or a signed GitHub push webhook. Shipyard keeps release history and logs, checks deployed health, and attempts a rollback where the target supports it. A bounded release queue runs up to two deployments at once by default (configurable from one to four), which prevents parallel builds from exhausting a small host. Run it locally on a trusted laptop or privately on a Linux host behind the included Caddy HTTPS and access-control proxy.

## Start on Windows

Requirements on the laptop:

- Node.js 22 or newer (the launcher checks PATH and the Node runtime bundled with Codex)
- OpenSSH client (included with current Windows versions)

Double-click `Start-Shipyard.cmd`, or open this folder in PowerShell and run:

```powershell
node server.mjs
```

Then open [http://localhost:4173](http://localhost:4173). Shipyard has no npm dependencies and binds to the laptop's loopback interface by default. The launcher waits for the health endpoint before opening the browser. It stores service configuration and release history in `data/shipyard.json`; that file is ignored by Git.

## Private production deployment

The production bundle runs Shipyard behind Caddy. Caddy obtains and renews an HTTPS certificate, protects the dashboard and API with an additional HTTP Basic Auth gate, and exposes only the signed GitHub webhook endpoint and health check without that gate. The Shipyard container is not published directly to the Internet. Use this as a private, single-workspace control plane; it is not a multi-tenant SaaS service.

You need a Linux server with Docker Engine and the Compose plugin, a DNS record pointing `SHIPYARD_DOMAIN` at that server, and firewall access to ports 80 and 443. From the Shipyard project directory on that server:

1. Copy `.env.production.example` to `.env.production` and set `SHIPYARD_DOMAIN` and `SHIPYARD_PUBLIC_URL` to your HTTPS host.
2. Generate a Caddy password hash with `docker run --rm caddy:2-alpine caddy hash-password --algorithm bcrypt`. Put it in `SHIPYARD_BASIC_AUTH_HASH` as a single-quoted value in `.env.production`, and choose a unique `SHIPYARD_BASIC_AUTH_USER`.
3. Create `runtime/ssh`, `runtime/kube`, and `runtime/docker`. Keep these folders private. Put SSH keys and a strict `known_hosts` file in `runtime/ssh`; put the target kubeconfig in `runtime/kube/config`.
4. For Kubernetes image pushes, authenticate on the server with `docker --config ./runtime/docker login ghcr.io` (or your registry). Protect this Docker config; it contains registry credentials.
5. To enable password-reset emails, set a valid Resend API key and verified sender in `RESEND_API_KEY` and `SHIPYARD_FROM_EMAIL`. Without both, password reset is unavailable in production; reset links are never written to production logs.
6. Start the stack with `docker compose --env-file .env.production -f compose.production.yaml up -d --build`.

Set `SHIPYARD_MAX_CONCURRENT_RELEASES` in `.env.production` to tune build concurrency for the server (1 to 4). The queue accepts up to 50 pending or active releases and rejects additional pushes until capacity is available.

Open the HTTPS URL configured by `SHIPYARD_DOMAIN`, pass the Caddy login, then create the first Shipyard account. In production, registration closes after that first account by default. Set `SHIPYARD_ALLOW_SIGNUP=1` only when you intentionally want to add another trusted user; accounts share the same workspace. To use Google sign-in, add that same HTTPS URL as the OAuth client's authorized JavaScript origin and configure its client ID in Shipyard or with `GOOGLE_CLIENT_ID`.

The control-plane image includes Git, OpenSSH, Docker CLI/Compose, kubectl, and Helm. The Docker socket is mounted so the control plane can build/push Kubernetes images; access to that socket is effectively administrative control of the host Docker daemon. Keep the Caddy gate, host account, runtime folders, and server private. The `runtime` directory and `.env.production` are ignored by Git.

In production, enter paths as seen inside the Shipyard container: SSH keys under `/root/.ssh`, kubeconfig under `/root/.kube`, and environment files at a mounted path. The service form labels these as paths on the Shipyard host. In the local Windows launcher, use Windows absolute paths as before.

### Back up and restore

Back up the workspace JSON (including user accounts, webhook secrets, deployment settings, and release history) before upgrades and on a regular schedule:

```bash
bash scripts/backup-production.sh
```

The default destination is the ignored `backups/` folder with private file permissions. Set `SHIPYARD_BACKUP_DIR` to store backups outside the project directory. Restore a saved file with:

```bash
bash scripts/restore-production.sh backups/shipyard-YYYYMMDDTHHMMSSZ-PID.json
```

The restore script validates the file, saves the current workspace first, stops Shipyard while replacing its data file, then starts it again. Store backups somewhere separate from the VPS as well; a backup on the same disk does not protect against disk loss.

## Sign in and account recovery

Create a Shipyard account with an email and password, or use **Continue with Google** from either the sign-in or sign-up screen. Passwords are stored as salted scrypt hashes. Google accounts are verified against Google's signing keys before a local session is created. Sessions last eight hours and remain valid across server restarts; only SHA-256 hashes of session tokens are stored in the data file. This is one shared workspace: all accounts on this installation see the same services and history.

For local password recovery, choose **Forgot password?**, enter your account email, then open the one-time link printed in the Shipyard server window. It expires after 20 minutes. For production, configure Resend with `RESEND_API_KEY`, `SHIPYARD_FROM_EMAIL`, and `SHIPYARD_PUBLIC_URL` to deliver one-time reset links by email. Reset tokens expire after 20 minutes and are single-use. For a Google account password reset, use [Google Account recovery](https://accounts.google.com/signin/recovery).

Google sign-in is optional. To configure it, create a Google OAuth web client with application type **Web application**, then add this exact **Authorized JavaScript origin**:

```text
http://localhost:4173
```

Paste the client ID ending in `.apps.googleusercontent.com` using **Set up Google sign-in** before the first account is created. After sign-in, change it from the account menu. The client ID is public; do not paste or store a client secret. Sessions last eight hours and remain valid across server restarts.

## Target requirements

For **Docker Compose over SSH**, the target should be a Linux server with:

- SSH access from the laptop, using a key that is already trusted in the server's `authorized_keys`
- Git and Docker Engine with the Docker Compose plugin
- `curl` for the post-deploy HTTP health check
- Read access to the selected Git repository from the server

The server's SSH host key must already be in the laptop's `known_hosts` file. Shipyard uses strict host-key checking. For a private GitHub repository, give the server a read-only deploy key or another server-side Git credential. Do not put a token in the clone URL.

## DevOps Toolkit

The **Toolkit** page checks local deployment tools and creates a downloadable starter bundle for Node.js, Python, or a static site. It includes Docker and Compose, a GitHub Actions workflow for checks and publishing an image to GHCR, a Jenkinsfile, Kubernetes Deployment and Service manifests, a Helm chart, and setup notes. The bundle adds an Ingress manifest when Ingress exposure is selected. Node, Python, and static-site starter containers use non-root defaults; generated Kubernetes workloads also drop Linux capabilities and use the runtime-default seccomp profile. Review the generated files for the app's actual start command, health endpoint, registry, Jenkins credentials, and cluster.

### Deployment targets

When connecting a service, choose one of four execution modes. The **Toolkit** page shows which local tools and cluster context Shipyard can currently reach.

- **Docker Compose over SSH** clones the configured branch on a Linux server, validates and builds its Compose project, updates the running containers, checks the HTTP endpoint, and attempts a source rollback if an update fails.
- **Kubernetes manifests** clones the branch onto the Shipyard host, builds and pushes a Docker image, applies a Deployment and Service, waits for the rollout and ready pods, and attempts to restore the previous revision if an update fails. Choose internal-only `ClusterIP`, a `LoadBalancer` service, or an `Ingress` hostname. Ingress mode can use a selected class and an existing TLS Secret; a registry image pull Secret can also be selected. It requires Docker Engine, Git, kubectl, a reachable Kubernetes cluster configured in a kubeconfig file, permission to create the selected namespace if it is missing, and prior Docker registry login.
- **Kubernetes with Helm** builds and pushes the same commit-tagged image, then runs `helm upgrade --install` on the chart path in the repository. Shipyard passes the configured image, replica, health, exposure, Ingress, and image-pull-secret settings to the chart. Helm waits for readiness and rolls back to the previous successful release on failure. Use a Shipyard Toolkit chart or a compatible chart that uses `image.repository`, `image.tag`, `replicaCount`, `containerPort`, `healthPath`, `service.port`, `service.type`, `ingress.*`, `imagePullSecrets`, and `fullnameOverride`. It requires Docker Engine, Git, Helm, kubectl, a reachable cluster, namespace access, and prior registry login.

For GHCR, authenticate with a token that can publish packages. For private images, create a `kubernetes.io/dockerconfigjson` Secret in the namespace and select its name. LoadBalancer exposure requires a cluster or cloud integration that provisions addresses. Ingress exposure requires an installed controller and DNS pointed at it; TLS requires an existing `kubernetes.io/tls` Secret. Shipyard does not provision cloud clusters, DNS records, or certificates.
- **Jenkins** triggers a parameterized Jenkins job and shows its live console output and final result. Configure that job from the repository's Jenkinsfile on the same branch. The pipeline expects Docker, kubectl, a container registry credential with ID `container-registry`, and a kubeconfig restricted to the target namespace on the Jenkins agent. Shipyard stores only the name of an environment variable; set that variable to the Jenkins API token before starting Shipyard. Do not commit or paste the token into Git.

GitHub push webhooks trigger the selected execution mode. GitHub must be able to reach Shipyard's webhook URL over HTTPS. The generated GitHub Actions workflow separately runs checks and publishes images; it does not deploy to Kubernetes by itself.

## Connect a service

In **New service**, enter:

1. A name, clone URL, branch, and deployment method.
2. The target's SSH details, Kubernetes cluster, image repository and exposure settings, or Jenkins URL and job, depending on the method.
3. The app's container port and health path.
4. For Jenkins, set the API token environment variable before starting Shipyard. For Kubernetes, sign Docker in to the image registry and choose a namespace; Shipyard creates it if it is missing and your cluster permissions allow that.

### Docker Compose deployment details

The repository's Compose project should bind the app to the configured server port. Shipyard runs Compose from the configured app directory and file. If an environment file is supplied, Shipyard copies it to `.shipyard.env` in that directory over SSH, sets its permissions to owner-only, and passes it to Compose for variable substitution. Add `env_file: .shipyard.env` in your Compose service if the container should receive those variables. Keep the file out of the repository.

Click **Deploy** to run a release. The pipeline connects over SSH, fetches the configured branch on the server, runs the optional check, validates Compose, builds images, updates services, and checks the HTTP endpoint. If deployment fails after the source changes, Shipyard checks out the prior commit and tries to rebuild and start that version.

## Push-to-deploy with GitHub

When a service is created, Shipyard displays its webhook URL and a randomly generated HMAC secret once. Save the secret. In the GitHub repository's **Settings → Webhooks**, set the payload URL, choose `application/json`, enter the secret, and subscribe to **Just the push event**. Shipyard verifies GitHub's `X-Hub-Signature-256` and deploys only pushes to the configured branch. If the secret is lost or exposed, rotate it from the service configuration and update GitHub's webhook secret. Service target settings can be edited without changing the webhook; deployment method is fixed to avoid abandoning live resources.

GitHub cannot call `localhost` on your laptop. Use the production Caddy endpoint or another secured HTTPS endpoint that routes only the webhook path to Shipyard. The included Caddy configuration bypasses its Basic Auth only for signed webhook requests and health checks. Keep webhook secrets private and rotate them from the service configuration page if exposed.

Shipyard refuses a non-loopback `HOST` unless remote access is explicitly enabled. For example, in PowerShell:

```powershell
$env:HOST = "0.0.0.0"
$env:SHIPYARD_ALLOW_REMOTE = "1"
npm start
```

This opt-in only changes the bind address. It does **not** make Shipyard safe for public hosting. Use a private network, HTTPS reverse proxy, firewall rules, and trusted users. The app has no tenant isolation or encrypted configuration storage.

## Operations and limitations

- A Compose release replaces that Compose project's running containers. Use persistent volumes for stateful workloads, and test Compose changes in a non-production environment first.
- SSH key, environment-file, kubeconfig paths, Jenkins URL, and webhook secret are stored in Shipyard's local JSON configuration without encryption. The key, kubeconfig, and Jenkins token contents are not stored. Protect the Windows account and do not commit `data/shipyard.json`.
- The configured Compose pre-deploy command runs on the target server in the checked-out repository. Kubernetes builds run the repository Dockerfile on the Shipyard host. Jenkins runs the Jenkinsfile on its configured agent. Only connect repositories you trust.
- Local external commands have a 30-minute ceiling and release output is capped so a noisy build cannot grow Shipyard's memory use without bound. Local tool checks use a shorter timeout.
- Compose rollback depends on the previous commit remaining available and Compose being able to rebuild it. Kubernetes rollback restores the last Deployment revision. Jenkins build failures are reported in Shipyard; add rollback steps to the Jenkinsfile for Jenkins-managed deployments. Database migrations and external side effects need their own rollback strategy.
- Shipyard is a private single-workspace control plane, not a multi-tenant hosted service. It does not provision cloud infrastructure or registry accounts, manage DNS records or certificates, provide team roles or release approval gates, or encrypt the workspace JSON at rest. Protect the host, data volume, `.env.production`, Docker socket, and runtime credential files. Backups include account hashes, reset tokens, and deployment/webhook configuration; store them privately.

## Checks

Run the source checks and isolated HTTP integration tests with:

```powershell
npm run check
npm test
```

The integration test launches a temporary Shipyard instance with a separate temporary data directory; it does not read or modify your normal `data/shipyard.json`.
