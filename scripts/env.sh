# Mit `source scripts/env.sh` laden.
# UCSIM_ROOT = Wurzel dieses Repos, Renode wird in $UCSIM_ROOT/bin/renode erwartet.
export UCSIM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$UCSIM_ROOT/bin/renode:$PATH"

# Pfad zum TI-Compiler (tiarmclang), ggf. anpassen:
export TI_BIN="${TI_BIN:-$HOME/tmp/ti/ccs2040/ccs/tools/compiler/ti-cgt-armllvm_4.0.4.LTS/bin}"
