#!/bin/bash
# Imports an example project into a CCS workspace without the GUI and builds it.
#   tools/ccs-import.sh examples/example01_blinky
#   tools/ccs-import.sh solutions/labs/lab01_hexkeypad_bcd/code     (reference solution, only with the submodule)
# Variables: CCS_ROOT (otherwise searched: newest ~/ti/ccs*/ccs, ~/tmp/ti/ccs*/ccs, /opt/ti/ccs*/ccs,
#            /Applications/ti/ccs*/ccs), WORKSPACE (~/ccs_workspace)
set -e
if [ -z "${CCS_ROOT:-}" ]; then
    for c in "$HOME"/ti/ccs*/ccs "$HOME"/tmp/ti/ccs*/ccs /opt/ti/ccs*/ccs /Applications/ti/ccs*/ccs; do
        [ -x "$c/eclipse/ccs-server-cli.sh" ] && CCS_ROOT="$c"     # sorted: the last match is the newest
    done
fi
WORKSPACE="${WORKSPACE:-$HOME/ccs_workspace}"
DIR="$(readlink -f "${1:?Usage: $0 examples/<example>}")"
NAME="$(basename "$DIR")"
# Reference solutions are in solutions/labs/<lab>/code: project name = lab folder
[ "$NAME" = code ] && NAME="$(basename "$(dirname "$DIR")")"
CLI="$CCS_ROOT/eclipse/ccs-server-cli.sh"
[ -x "$CLI" ] || { echo "CCS not found${CCS_ROOT:+ in $CCS_ROOT} (set CCS_ROOT)" >&2; exit 1; }
"$CLI" -workspace "$WORKSPACE" -application projectImport -ccs.location "$DIR/$NAME.projectspec"
"$CLI" -workspace "$WORKSPACE" -application projectBuild -ccs.projects "$NAME" -ccs.configuration Debug
echo "Done: $WORKSPACE/$NAME/Debug/$NAME.out"
