#!/bin/bash
# Importiert ein Beispielprojekt ohne GUI in einen CCS-Workspace und baut es.
#   tools/ccs-import.sh examples/example01_blinky
# Variablen (Standardwerte in Klammern): CCS_ROOT (~/ti/ccs2040/ccs bzw. ~/tmp/ti/ccs2040/ccs), WORKSPACE (~/ccs_workspace)
set -e
# Ohne CCS_ROOT: ~/ti/ccs2040/ccs, sonst ~/tmp/ti/ccs2040/ccs
if [ -z "${CCS_ROOT:-}" ]; then
    CCS_ROOT="$HOME/ti/ccs2040/ccs"
    [ -d "$CCS_ROOT" ] || [ ! -d "$HOME/tmp/ti/ccs2040/ccs" ] || CCS_ROOT="$HOME/tmp/ti/ccs2040/ccs"
fi
WORKSPACE="${WORKSPACE:-$HOME/ccs_workspace}"
DIR="$(readlink -f "${1:?Aufruf: $0 examples/<beispiel>}")"
NAME="$(basename "$DIR")"
CLI="$CCS_ROOT/eclipse/ccs-server-cli.sh"
[ -x "$CLI" ] || { echo "CCS nicht gefunden unter $CCS_ROOT (CCS_ROOT setzen)" >&2; exit 1; }
"$CLI" -workspace "$WORKSPACE" -application projectImport -ccs.location "$DIR/$NAME.projectspec"
"$CLI" -workspace "$WORKSPACE" -application projectBuild -ccs.projects "$NAME" -ccs.configuration Debug
echo "Fertig: $WORKSPACE/$NAME/Debug/$NAME.out"
