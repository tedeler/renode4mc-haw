# syntax=docker/dockerfile:1
# ------------------------------------------------------------------------------------------------
# renode4mc-haw Web-Konsole – ein Container mit drei Schichten:
#   Node.js/Express (Entrypoint, Upload, Prozess-Management, WebSocket-Brücken, statische SPA)
#   Renode 1.17.0 portable (headless, TM4C1294-Modelle aus sim/)
#   React-Frontend (zur Build-Zeit gebaut, als statische Dateien in /app/public)
#
# Build-Kontext ist das Repository-Wurzelverzeichnis (sim/ wird mit in das Image kopiert):
#   docker build -f webconsole/Dockerfile -t renode4mc-webconsole \
#     --build-arg GIT_COMMIT=$(git rev-parse HEAD) --build-arg GIT_DATE=$(git log -1 --format=%cI) .
#   docker run --rm --init -p 3000:3000 -p 3333:3333 -p 3334:3334 renode4mc-webconsole
# ------------------------------------------------------------------------------------------------
ARG NODE_IMAGE=node:20-bookworm-slim

# ---------- Stage 1: React-Frontend bauen ------------------------------------------------------
FROM ${NODE_IMAGE} AS frontend
WORKDIR /build
COPY webconsole/frontend/package.json webconsole/frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY webconsole/frontend/ ./
# Git-Stand für den Über-Dialog (.git ist nicht im Build-Kontext):
#   docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) --build-arg GIT_DATE=$(git log -1 --format=%cI) ...
ARG GIT_COMMIT=""
ARG GIT_BRANCH=""
ARG GIT_DATE=""
RUN GIT_COMMIT="$GIT_COMMIT" GIT_BRANCH="$GIT_BRANCH" GIT_DATE="$GIT_DATE" npm run build

# ---------- Stage 2: Backend-Abhängigkeiten (nur production) -----------------------------------
FROM ${NODE_IMAGE} AS backend
WORKDIR /app
COPY webconsole/backend/package.json webconsole/backend/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY webconsole/backend/ ./

# ---------- Stage 3: Renode (portable, gleiche Version wie in docs/INSTALL_LINUX.md) ----------
FROM ${NODE_IMAGE} AS renode
ARG RENODE_VERSION=1.17.0
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN case "${TARGETARCH:-amd64}" in \
      amd64) PKG=linux-portable ;; \
      arm64) PKG=linux-arm64-portable ;; \
      *) echo "Architektur ${TARGETARCH} wird von Renode nicht unterstützt" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/renode.tar.gz \
      "https://github.com/renode/renode/releases/download/v${RENODE_VERSION}/renode-${RENODE_VERSION}.${PKG}.tar.gz" \
 && mkdir -p /opt/renode \
 && tar xf /tmp/renode.tar.gz -C /opt/renode --strip-components=1 \
 && rm /tmp/renode.tar.gz

# ---------- Stage 3b: Musterlösungen (examples/lab01..lab04) mit arm-none-eabi-gcc bauen -------------
FROM ${NODE_IMAGE} AS solutions
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc-arm-none-eabi libnewlib-arm-none-eabi \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY common ./common
COPY examples ./examples
COPY tools ./tools
RUN OUT=/out sh tools/build-solutions.sh

# ---------- Stage 4: Runtime ---------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
# libssl3: wird von .NET (Renode) zur Laufzeit geladen; procps: pkill. Kein Compiler, keine IDE.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libssl3 procps \
 && rm -rf /var/lib/apt/lists/*

COPY --from=renode /opt/renode /opt/renode
RUN ln -s /opt/renode/renode /usr/local/bin/renode

WORKDIR /app
COPY --from=backend /app /app
COPY --from=frontend /build/dist /app/public
# Simulator aus dem Repository: Modelle, Plattform, Versuche (Renode-Arbeitsverzeichnis)
COPY sim /opt/renode4mc/sim
COPY common/tm4c1294ncpdt.h /opt/renode4mc/common/tm4c1294ncpdt.h
# Musterlösungen für "Musterlösung starten" in der Web-Konsole
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

# Ohne Root-Rechte laufen (Benutzer "node" aus dem Node-Image)
USER node

# 3000 = HTTP (SPA, POST /upload, /api), 3333 = UART-WebSocket, 3334 = Control-WebSocket.
# Intern (nicht exponiert): 1234 Renode-Monitor, 1235 Abfrage-Port, 3335 UART-TCP, 9000 LED-Bridge.
EXPOSE 3000 3333 3334

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "server.js"]
