#!/bin/sh
# Start the web console in Docker – Linux and macOS (Windows: StartDocker.bat).
#
#   ./StartDocker.sh            build (only what changed), start in the background, open the browser
#   ./StartDocker.sh stop       stop
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

echo "Building and starting the web console (the first time this takes a few minutes) ..."
compose up -d --build

# ---- wait until the user interface answers ---------------------------------------------------------
ready() {
    if command -v curl >/dev/null 2>&1; then curl -fs "$URL/api/status" >/dev/null 2>&1
    elif command -v wget >/dev/null 2>&1; then wget -q -O /dev/null "$URL/api/status"
    else return 0
    fi
}
printf "Waiting for %s " "$URL"
i=0
until ready; do
    i=$((i + 1))
    [ "$i" -ge 60 ] && { echo; fail "The web console does not answer. Show the output: $0 logs"; }
    printf "."
    sleep 2
done
echo " ready."

# ---- open the browser -----------------------------------------------------------------------------
case "$(uname -s)" in
    Darwin) open "$URL" ;;
    *)      if command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
                xdg-open "$URL" >/dev/null 2>&1 &
            fi ;;
esac

echo
echo "Web console running: $URL"
echo "  Stop:    $0 stop"
echo "  Output:  $0 logs"
echo "The container keeps running in the background (also after a reboot) until you stop it."
