#!/bin/sh
# Provides the reference solutions for the web console: OUT/<name>.elf (default sim/solutions/),
# can be started in the browser with the "Reference solution" button.
#
#   tools/build-solutions.sh                     # gcc from PATH
#   CC=/opt/gcc/bin/arm-none-eabi-gcc tools/build-solutions.sh
#   OUT=/somewhere tools/build-solutions.sh      # different output directory
#   SOLUTIONS_DIR=/path tools/build-solutions.sh # sources of the lab reference solutions (default: solutions/)
#
# Two sources:
#   1. examples with a reference solution from examples/ (public, list EXAMPLES below) – always built.
#   2. lab reference solutions from the private submodule solutions/ (haw-mc-labsolutions, one per lab in
#      solutions/labs/<lab>/code/). Only people with access have the sources there; then they are built
#      without debug info (the symbols stay for the web console) and replace the ready-made ELFs.
#      Without sources, the ready-made ELFs checked in to sim/solutions/ are used.
#
# The Docker image (webconsole/Dockerfile) runs this script itself while it is built.
# Instead of the TI run-time library the gcc build uses newlib; printf() still goes to the CCS console
# of the simulator via tools/gcc/cio_gcc.c. For the real board, please build with CCS or "make".
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CC=${CC:-arm-none-eabi-gcc}
if [ -z "${OBJCOPY:-}" ]; then              # arm-none-eabi-gcc -> arm-none-eabi-objcopy (same directory)
    case "$CC" in
        */*) OBJCOPY="$(dirname "$CC")/$(basename "$CC" gcc)objcopy" ;;
        *)   OBJCOPY="$(basename "$CC" gcc)objcopy" ;;
    esac
fi
OUT=${OUT:-$ROOT/sim/solutions}
SOLUTIONS_DIR=${SOLUTIONS_DIR:-$ROOT/solutions}
PREBUILT=$ROOT/sim/solutions
EXAMPLES="example05_timer_ccp"

build() { # <name> <source directory>
    "$CC" -mcpu=cortex-m4 -mthumb -mfloat-abi=soft -Os -g -Wall -nostartfiles --specs=nano.specs \
        -T "$ROOT/tools/gcc/link.ld" -I "$2" -I "$ROOT/common" \
        "$2"/*.c "$ROOT/common/startup_tm4c1294.c" "$ROOT/tools/gcc/crt.c" "$ROOT/tools/gcc/cio_gcc.c" \
        -o "$OUT/$1.elf"
}

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

# 1. take over the ready-made lab ELFs (if OUT is a different directory, e.g. in the Docker build)
if [ "$OUT" != "$(cd "$PREBUILT" 2>/dev/null && pwd)" ]; then
    for f in "$PREBUILT"/*.elf; do
        [ -f "$f" ] && cp "$f" "$OUT/"
    done
fi

# 2. examples from examples/
for ex in $EXAMPLES; do
    echo "[build-solutions] $ex (examples/)"
    build "$ex" "$ROOT/examples/$ex"
done

# 3. lab reference solutions from the submodule, if the sources are there
found=0
for dir in "$SOLUTIONS_DIR"/labs/*/code; do
    ls "$dir"/*.c >/dev/null 2>&1 || continue
    lab=$(basename "$(dirname "$dir")")
    echo "[build-solutions] $lab (solutions/, sources)"
    build "$lab" "$dir"
    "$OBJCOPY" --strip-debug "$OUT/$lab.elf"
    found=$((found + 1))
done
if [ "$found" -eq 0 ]; then
    echo "[build-solutions] no sources in $SOLUTIONS_DIR – lab reference solutions: ready-made ELFs from sim/solutions/"
    for f in "$OUT"/lab*.elf; do [ -f "$f" ] && echo "    $(basename "$f")"; done
fi
echo "[build-solutions] done: $OUT"
