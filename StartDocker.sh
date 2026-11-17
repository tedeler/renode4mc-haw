#!/bin/sh
# Web-Konsole in Docker starten – Linux und macOS (Windows: StartDocker.bat).
#
#   ./StartDocker.sh            bauen (nur Geändertes) und im Hintergrund starten, Browser öffnen
#   ./StartDocker.sh stop       anhalten
#   ./StartDocker.sh logs       Ausgaben ansehen (Strg+C beendet nur die Anzeige)
#   ./StartDocker.sh status     läuft der Container?
#
# Voraussetzung: Docker mit Compose (Linux: Docker Engine + Compose-Plugin, macOS: Docker Desktop).
# Die Oberfläche: http://localhost:3000 (zusätzlich belegt: Ports 3333 und 3334).
set -e
cd "$(dirname "$0")"

URL=http://localhost:3000
COMPOSE_FILE=webconsole/docker-compose.yml

fail() { echo "FEHLER: $*" >&2; exit 1; }

# ---- Docker vorhanden und erreichbar? -----------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail "Docker ist nicht installiert – siehe https://docs.docker.com/get-docker/"
if ! docker info >/dev/null 2>&1; then
    case "$(uname -s)" in
        Darwin) fail "Docker läuft nicht. Bitte Docker Desktop starten und warten, bis es bereit ist." ;;
        *)      fail "Docker läuft nicht oder Ihr Benutzer darf es nicht verwenden.
       Starten:        sudo systemctl start docker
       Rechte (einmal): sudo usermod -aG docker \$USER   und danach neu anmelden" ;;
    esac
fi

if docker compose version >/dev/null 2>&1; then
    compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
    compose() { docker-compose -f "$COMPOSE_FILE" "$@"; }
else
    fail "Docker Compose fehlt (Linux: Paket docker-compose-plugin installieren)."
fi

# ---- Befehle --------------------------------------------------------------------------------------
case "${1:-start}" in
    stop)   compose down; exit 0 ;;
    logs)   compose logs -f; exit 0 ;;
    status) compose ps; exit 0 ;;
    start)  ;;
    *)      echo "Aufruf: $0 [start|stop|logs|status]" >&2; exit 2 ;;
esac

# Git-Stand für den Über-Dialog (Klick aufs Logo); ohne git bleibt er leer
if command -v git >/dev/null 2>&1 && git rev-parse HEAD >/dev/null 2>&1; then
    GIT_COMMIT=$(git rev-parse HEAD)
    GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
    GIT_DATE=$(git log -1 --format=%cI)
    export GIT_COMMIT GIT_BRANCH GIT_DATE
fi

echo "Baue und starte die Web-Konsole (beim ersten Mal dauert das einige Minuten) ..."
compose up -d --build

# ---- warten, bis die Oberfläche antwortet --------------------------------------------------------
ready() {
    if command -v curl >/dev/null 2>&1; then curl -fs "$URL/api/status" >/dev/null 2>&1
    elif command -v wget >/dev/null 2>&1; then wget -q -O /dev/null "$URL/api/status"
    else return 0
    fi
}
printf "Warte auf %s " "$URL"
i=0
until ready; do
    i=$((i + 1))
    [ "$i" -ge 60 ] && { echo; fail "Die Web-Konsole antwortet nicht. Ausgaben ansehen: $0 logs"; }
    printf "."
    sleep 2
done
echo " bereit."

# ---- Browser öffnen --------------------------------------------------------------------------------
case "$(uname -s)" in
    Darwin) open "$URL" ;;
    *)      if command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
                xdg-open "$URL" >/dev/null 2>&1 &
            fi ;;
esac

echo
echo "Web-Konsole läuft: $URL"
echo "  Anhalten:  $0 stop"
echo "  Ausgaben:  $0 logs"
echo "Der Container läuft im Hintergrund weiter (auch nach einem Neustart), bis Sie ihn anhalten."
