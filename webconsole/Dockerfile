# syntax=docker/dockerfile:1
# ------------------------------------------------------------------------------------------------
# renode4mc-haw web console – one container with three layers:
#   Node.js/Express (entry point, upload, process management, WebSocket bridges, static SPA)
#   Renode 1.17.0 portable (headless, TM4C1294 models from sim/)
#   React frontend (built at build time, as static files in /app/public)
#
# The build context is the repository root (sim/ is copied into the image as well):
#   docker build -f webconsole/Dockerfile -t renode4mc-webconsole \
#     --build-arg GIT_COMMIT=$(git rev-parse HEAD) --build-arg GIT_DATE=$(git log -1 --format=%cI) .
#   docker run --rm --init -p 3000:3000 -p 3333:3333 -p 3334:3334 renode4mc-webconsole
# ------------------------------------------------------------------------------------------------
ARG NODE_IMAGE=node:20-bookworm-slim

# ---------- Stage 1: build the React frontend --------------------------------------------------
FROM ${NODE_IMAGE} AS frontend
WORKDIR /build
COPY webconsole/frontend/package.json webconsole/frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY webconsole/frontend/ ./
# Git version for the About dialog (.git is not in the build context):
#   docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) --build-arg GIT_DATE=$(git log -1 --format=%cI) ...
ARG GIT_COMMIT=""
ARG GIT_BRANCH=""
ARG GIT_DATE=""
RUN GIT_COMMIT="$GIT_COMMIT" GIT_BRANCH="$GIT_BRANCH" GIT_DATE="$GIT_DATE" npm run build

# ---------- Stage 2: backend dependencies (production only) ------------------------------------
FROM ${NODE_IMAGE} AS backend
WORKDIR /app
COPY webconsole/backend/package.json webconsole/backend/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY webconsole/backend/ ./

# ---------- Stage 3: Renode (portable, same version as in docs/INSTALL_LINUX.md) --------------
FROM ${NODE_IMAGE} AS renode
ARG RENODE_VERSION=1.17.0
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN case "${TARGETARCH:-amd64}" in \
      amd64) PKG=linux-portable ;; \
      arm64) PKG=linux-arm64-portable ;; \
      *) echo "Architecture ${TARGETARCH} is not supported by Renode" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/renode.tar.gz \
      "https://github.com/renode/renode/releases/download/v${RENODE_VERSION}/renode-${RENODE_VERSION}.${PKG}.tar.gz" \
 && mkdir -p /opt/renode \
 && tar xf /tmp/renode.tar.gz -C /opt/renode --strip-components=1 \
 && rm /tmp/renode.tar.gz

# ---------- Stage 3b: reference solutions for the "Reference solution" button ------------------
# tools/build-solutions.sh builds example05 from examples/ and – only if the private submodule
# solutions/ is checked out (teaching staff) – the lab reference solutions from their sources. Without
# the submodule (students, forks) the ready-made ELFs from sim/solutions/ are used. The build context is
# only read via a bind mount: the sources of the reference solutions end up in no image layer, only the
# ELF files in /out.
FROM ${NODE_IMAGE} AS solutions
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc-arm-none-eabi binutils-arm-none-eabi libnewlib-arm-none-eabi \
 && rm -rf /var/lib/apt/lists/*
RUN --mount=type=bind,target=/ctx \
    OUT=/out sh /ctx/tools/build-solutions.sh

# ---------- Stage 4: Runtime ---------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
# libssl3: loaded by .NET (Renode) at run time; procps: pkill. No compiler, no IDE.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libssl3 procps \
 && rm -rf /var/lib/apt/lists/*

COPY --from=renode /opt/renode /opt/renode
RUN ln -s /opt/renode/renode /usr/local/bin/renode

WORKDIR /app
COPY --from=backend /app /app
COPY --from=frontend /build/dist /app/public
# Simulator from the repository: models, platform, experiments (Renode working directory)
COPY sim /opt/renode4mc/sim
COPY common/tm4c1294ncpdt.h /opt/renode4mc/common/tm4c1294ncpdt.h
# Reference solutions for the "Reference solution" button in the web console
COPY --from=solutions /out /opt/renode4mc/sim/solutions

ENV NODE_ENV=production \
    PORT=3000 \
    UART_WS_PORT=3333 \
    CONTROL_WS_PORT=3334 \
    RENODE_BIN=renode \
    RENODE_HEADLESS_FLAG=--disable-gui \
    RENODE_MONITOR_PORT=1234 \
    RENODE_UART_PORT=3335 \
    SIM_DIR=/opt/renode4mc/sim \
    HEADER_PATH=/opt/renode4mc/common/tm4c1294ncpdt.h \
    ELF_PATH=/tmp/app.elf \
    PUBLIC_DIR=/app/public

# Run without root rights (user "node" from the Node image)
USER node

# 3000 = HTTP (SPA, POST /upload, /api), 3333 = UART WebSocket, 3334 = control WebSocket.
# Internal (not exposed): 1234 Renode monitor, 1235 query port, 3335 UART TCP, 9000 LED bridge.
EXPOSE 3000 3333 3334

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "server.js"]
