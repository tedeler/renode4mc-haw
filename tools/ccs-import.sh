#!/bin/bash
# Importiert ein Beispielprojekt ohne GUI in einen CCS-Workspace und baut es.
#   tools/ccs-import.sh examples/lab01_blinky
# Variablen (Standardwerte in Klammern): CCS_ROOT (~/ti/ccs2040/ccs), TIVAWARE_ROOT
# (~/ti/TivaWare_C_Series-2.2.0.295), WORKSPACE (~/ccs_workspace)
set -e
CCS_ROOT="${CCS_ROOT:-$HOME/ti/ccs2040/ccs}"
TIVAWARE_ROOT="${TIVAWARE_ROOT:-$HOME/ti/TivaWare_C_Series-2.2.0.295}"
WORKSPACE="${WORKSPACE:-$HOME/ccs_workspace}"
DIR="$(readlink -f "${1:?Aufruf: $0 examples/<beispiel>}")"
NAME="$(basename "$DIR")"
CLI="$CCS_ROOT/eclipse/ccs-server-cli.sh"
[ -x "$CLI" ] || { echo "CCS nicht gefunden unter $CCS_ROOT (CCS_ROOT setzen)" >&2; exit 1; }
[ -d "$TIVAWARE_ROOT/driverlib" ] || { echo "TivaWare nicht gefunden unter $TIVAWARE_ROOT (TIVAWARE_ROOT setzen)" >&2; exit 1; }
"$CLI" -workspace "$WORKSPACE" -application projectImport -ccs.location "$DIR/$NAME.projectspec" \
    -ccs.definePathVariable TIVAWARE_ROOT "$TIVAWARE_ROOT"
"$CLI" -workspace "$WORKSPACE" -application projectBuild -ccs.projects "$NAME" -ccs.configuration Debug
echo "Fertig: $WORKSPACE/$NAME/Debug/$NAME.out"
