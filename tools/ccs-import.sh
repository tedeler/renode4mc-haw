#!/bin/bash
# Importiert ein Beispielprojekt ohne GUI in einen CCS-Workspace und baut es.
#   tools/ccs-import.sh examples/example01_blinky
#   tools/ccs-import.sh solutions/labs/lab01_hexkeypad_bcd/code     (Musterlösung, nur mit Submodul)
# Variablen: CCS_ROOT (sonst gesucht: neueste ~/ti/ccs*/ccs, ~/tmp/ti/ccs*/ccs, /opt/ti/ccs*/ccs,
#            /Applications/ti/ccs*/ccs), WORKSPACE (~/ccs_workspace)
set -e
if [ -z "${CCS_ROOT:-}" ]; then
    for c in "$HOME"/ti/ccs*/ccs "$HOME"/tmp/ti/ccs*/ccs /opt/ti/ccs*/ccs /Applications/ti/ccs*/ccs; do
        [ -x "$c/eclipse/ccs-server-cli.sh" ] && CCS_ROOT="$c"     # sortiert: der letzte Treffer ist der neueste
    done
fi
WORKSPACE="${WORKSPACE:-$HOME/ccs_workspace}"
DIR="$(readlink -f "${1:?Aufruf: $0 examples/<beispiel>}")"
NAME="$(basename "$DIR")"
# Musterlösungen liegen in solutions/labs/<labor>/code: Projektname = Laborordner
[ "$NAME" = code ] && NAME="$(basename "$(dirname "$DIR")")"
CLI="$CCS_ROOT/eclipse/ccs-server-cli.sh"
[ -x "$CLI" ] || { echo "CCS nicht gefunden${CCS_ROOT:+ unter $CCS_ROOT} (CCS_ROOT setzen)" >&2; exit 1; }
"$CLI" -workspace "$WORKSPACE" -application projectImport -ccs.location "$DIR/$NAME.projectspec"
"$CLI" -workspace "$WORKSPACE" -application projectBuild -ccs.projects "$NAME" -ccs.configuration Debug
echo "Fertig: $WORKSPACE/$NAME/Debug/$NAME.out"
