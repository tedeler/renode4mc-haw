#!/bin/sh
# Baut die Musterlösungen (examples/lab01..lab04) mit arm-none-eabi-gcc für die Web-Konsole.
# Ergebnis: sim/solutions/<Beispiel>.elf – im Browser per "Musterlösung starten" ladbar.
#
#   tools/build-solutions.sh                     # gcc aus dem PATH
#   CC=/opt/gcc/bin/arm-none-eabi-gcc tools/build-solutions.sh
#   OUT=/irgendwo tools/build-solutions.sh       # anderes Zielverzeichnis
#
# Das Docker-Image (webconsole/Dockerfile) ruft das Skript beim Bauen selbst auf.
# Statt des TI-Laufzeitsystems nutzt der gcc-Build newlib; printf() läuft über tools/gcc/cio_gcc.c
# trotzdem in die CCS-Konsole des Simulators. Auf dem Board bitte mit CCS bzw. "make" bauen.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CC=${CC:-arm-none-eabi-gcc}
OUT=${OUT:-$ROOT/sim/solutions}
SOLUTIONS="lab01_hexkeypad_bcd lab02_led_pendel lab03_nvic_pendel lab04_uart_leds"

mkdir -p "$OUT"
for ex in $SOLUTIONS; do
    dir="$ROOT/examples/$ex"
    echo "[build-solutions] $ex"
    "$CC" -mcpu=cortex-m4 -mthumb -mfloat-abi=soft -Os -g -Wall -nostartfiles --specs=nano.specs \
        -T "$ROOT/tools/gcc/link.ld" -I "$dir" -I "$ROOT/common" \
        "$dir"/*.c "$ROOT/common/startup_tm4c1294.c" "$ROOT/tools/gcc/crt.c" "$ROOT/tools/gcc/cio_gcc.c" \
        -o "$OUT/$ex.elf"
done
echo "[build-solutions] fertig: $OUT"
