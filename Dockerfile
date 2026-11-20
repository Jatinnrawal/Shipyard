ARG DOCKER_CLI_VERSION=29.9.3
FROM docker:${DOCKER_CLI_VERSION}-cli AS dockercli

FROM node:22-bookworm-slim

ARG KUBECTL_VERSION=v1.36.5
ARG HELM_VERSION=v4.3.1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && case "$(dpkg --print-architecture)" in \
         amd64) KUBECTL_ARCH=amd64 ;; \
         arm64) KUBECTL_ARCH=arm64 ;; \
         *) echo "Unsupported architecture for kubectl" >&2; exit 1 ;; \
       esac \
    && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${KUBECTL_ARCH}/kubectl" \
    && curl -fsSLo /tmp/kubectl.sha256 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${KUBECTL_ARCH}/kubectl.sha256" \
    && echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum --check - \
    && chmod 0755 /usr/local/bin/kubectl \
    && rm -f /tmp/kubectl.sha256

RUN case "$(dpkg --print-architecture)" in \
         amd64) HELM_ARCH=amd64 ;; \
         arm64) HELM_ARCH=arm64 ;; \
         *) echo "Unsupported architecture for Helm" >&2; exit 1 ;; \
       esac \
    && curl -fsSLo /tmp/helm.tar.gz "https://get.helm.sh/helm-${HELM_VERSION}-linux-${HELM_ARCH}.tar.gz" \
    && curl -fsSLo /tmp/helm.tar.gz.sha256sum "https://get.helm.sh/helm-${HELM_VERSION}-linux-${HELM_ARCH}.tar.gz.sha256sum" \
    && (cd /tmp && sha256sum --check helm.tar.gz.sha256sum) \
    && tar -xzf /tmp/helm.tar.gz -C /tmp \
    && install -m 0755 "/tmp/linux-${HELM_ARCH}/helm" /usr/local/bin/helm \
    && rm -rf /tmp/helm.tar.gz /tmp/helm.tar.gz.sha256sum "/tmp/linux-${HELM_ARCH}"

COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    SHIPYARD_ALLOW_REMOTE=1 \
    SHIPYARD_COOKIE_SECURE=1 \
    SHIPYARD_DATA_DIR=/var/lib/shipyard

WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public

RUN mkdir -p /var/lib/shipyard /tmp/shipyard-builds \
    && chown -R root:root /app /var/lib/shipyard \
    && chmod 0700 /var/lib/shipyard

VOLUME ["/var/lib/shipyard"]
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
