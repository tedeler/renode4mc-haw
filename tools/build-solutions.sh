#!/bin/sh
# Stellt die Musterlösungen für die Web-Konsole bereit: OUT/<Name>.elf (Standard sim/solutions/),
# im Browser per "Musterlösung starten" ladbar.
#
#   tools/build-solutions.sh                     # gcc aus dem PATH
#   CC=/opt/gcc/bin/arm-none-eabi-gcc tools/build-solutions.sh
#   OUT=/irgendwo tools/build-solutions.sh       # anderes Zielverzeichnis
#   SOLUTIONS_DIR=/pfad tools/build-solutions.sh # Quellen der Labor-Musterlösungen (Standard: solutions/)
#
# Zwei Quellen:
#   1. Beispiele mit Musterlösung aus examples/ (öffentlich, Liste EXAMPLES unten) – werden immer gebaut.
#   2. Labor-Musterlösungen aus dem privaten Submodul solutions/ (haw-mc-labsolutions, je Labor
#      solutions/labs/<labor>/code/). Nur wer Zugriff hat, hat dort Quellen; dann werden sie gebaut,
#      ohne Debug-Infos (die Symbole bleiben für die Web-Konsole), und ersetzen die fertigen ELFs.
#      Ohne Quellen gelten die fertigen ELFs, die in sim/solutions/ eingecheckt sind.
#
# Das Docker-Image (webconsole/Dockerfile) ruft das Skript beim Bauen selbst auf.
# Statt des TI-Laufzeitsystems nutzt der gcc-Build newlib; printf() läuft über tools/gcc/cio_gcc.c
# trotzdem in die CCS-Konsole des Simulators. Auf dem Board bitte mit CCS bzw. "make" bauen.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CC=${CC:-arm-none-eabi-gcc}
if [ -z "${OBJCOPY:-}" ]; then              # arm-none-eabi-gcc -> arm-none-eabi-objcopy (gleiches Verzeichnis)
    case "$CC" in
        */*) OBJCOPY="$(dirname "$CC")/$(basename "$CC" gcc)objcopy" ;;
        *)   OBJCOPY="$(basename "$CC" gcc)objcopy" ;;
    esac
fi
OUT=${OUT:-$ROOT/sim/solutions}
SOLUTIONS_DIR=${SOLUTIONS_DIR:-$ROOT/solutions}
PREBUILT=$ROOT/sim/solutions
EXAMPLES="example05_timer_ccp"

build() { # <name> <quellverzeichnis>
    "$CC" -mcpu=cortex-m4 -mthumb -mfloat-abi=soft -Os -g -Wall -nostartfiles --specs=nano.specs \
        -T "$ROOT/tools/gcc/link.ld" -I "$2" -I "$ROOT/common" \
        "$2"/*.c "$ROOT/common/startup_tm4c1294.c" "$ROOT/tools/gcc/crt.c" "$ROOT/tools/gcc/cio_gcc.c" \
        -o "$OUT/$1.elf"
}

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

# 1. fertige Labor-ELFs übernehmen (falls OUT ein anderes Verzeichnis ist, z. B. im Docker-Build)
if [ "$OUT" != "$(cd "$PREBUILT" 2>/dev/null && pwd)" ]; then
    for f in "$PREBUILT"/*.elf; do
        [ -f "$f" ] && cp "$f" "$OUT/"
    done
fi

# 2. Beispiele aus examples/
for ex in $EXAMPLES; do
    echo "[build-solutions] $ex (examples/)"
    build "$ex" "$ROOT/examples/$ex"
done

# 3. Labor-Musterlösungen aus dem Submodul, sofern Quellen vorhanden
found=0
for dir in "$SOLUTIONS_DIR"/labs/*/code; do
    ls "$dir"/*.c >/dev/null 2>&1 || continue
    lab=$(basename "$(dirname "$dir")")
    echo "[build-solutions] $lab (solutions/, Quellen)"
    build "$lab" "$dir"
    "$OBJCOPY" --strip-debug "$OUT/$lab.elf"
    found=$((found + 1))
done
if [ "$found" -eq 0 ]; then
    echo "[build-solutions] keine Quellen in $SOLUTIONS_DIR – Labor-Musterlösungen: fertige ELFs aus sim/solutions/"
    for f in "$OUT"/lab*.elf; do [ -f "$f" ] && echo "    $(basename "$f")"; done
fi
echo "[build-solutions] fertig: $OUT"
