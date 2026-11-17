#!/bin/sh
# Start the web console in Docker – Linux and macOS (Windows: StartDocker.bat).
#
#   ./StartDocker.sh            build (only what changed) and run in this terminal, open the browser;
#                               Ctrl+C stops the web console
#   ./StartDocker.sh stop       stop (if it is still running, e.g. after the terminal was closed)
#   ./StartDocker.sh logs       show the output (Ctrl+C only ends the display)
#   ./StartDocker.sh status     is the container running?
#
# Requirement: Docker with Compose (Linux: Docker Engine + Compose plugin, macOS: Docker Desktop).
# The user interface: http://localhost:3000 (also used: ports 3333 and 3334).
set -e
cd "$(dirname "$0")"

URL=http://localhost:3000
COMPOSE_FILE=webconsole/docker-compose.yml

fail() { echo "ERROR: $*" >&2; exit 1; }

# ---- is Docker installed and reachable? --------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail "Docker is not installed – see https://docs.docker.com/get-docker/"
if ! docker info >/dev/null 2>&1; then
    case "$(uname -s)" in
        Darwin) fail "Docker is not running. Please start Docker Desktop and wait until it is ready." ;;
        *)      fail "Docker is not running, or your user is not allowed to use it.
       Start it:          sudo systemctl start docker
       Rights (once):     sudo usermod -aG docker \$USER   and then log in again" ;;
    esac
fi

if docker compose version >/dev/null 2>&1; then
    compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
    compose() { docker-compose -f "$COMPOSE_FILE" "$@"; }
else
    fail "Docker Compose is missing (Linux: install the package docker-compose-plugin)."
fi

# ---- commands -------------------------------------------------------------------------------------
case "${1:-start}" in
    stop)   compose down; exit 0 ;;
    logs)   compose logs -f; exit 0 ;;
    status) compose ps; exit 0 ;;
    start)  ;;
    *)      echo "Usage: $0 [start|stop|logs|status]" >&2; exit 2 ;;
esac

# Git version for the About dialog (click on the logo); without git it stays empty
if command -v git >/dev/null 2>&1 && git rev-parse HEAD >/dev/null 2>&1; then
    GIT_COMMIT=$(git rev-parse HEAD)
    GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
    GIT_DATE=$(git log -1 --format=%cI)
    export GIT_COMMIT GIT_BRANCH GIT_DATE
fi

# ---- open the browser as soon as the user interface answers (runs alongside docker compose) ------
ready() {
    if command -v curl >/dev/null 2>&1; then curl -fs "$URL/api/status" >/dev/null 2>&1
    elif command -v wget >/dev/null 2>&1; then wget -q -O /dev/null "$URL/api/status"
    else sleep 20     # neither curl nor wget: just wait a little
    fi
}
open_when_ready() {          # ends on its own as soon as this script has ended ($$ = this script)
    until ready; do
        kill -0 $$ 2>/dev/null || exit 0
        sleep 2
    done
    kill -0 $$ 2>/dev/null || exit 0
    echo
    echo ">>> Web console ready: $URL   (Ctrl+C stops it)"
    echo
    case "$(uname -s)" in
        Darwin) open "$URL" ;;
        *)      if command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
                    xdg-open "$URL" >/dev/null 2>&1
                fi ;;
    esac
}
open_when_ready &

echo "Building and starting the web console (the first time this takes a few minutes) ..."
echo "It runs in this terminal; Ctrl+C stops it."
compose up --build
