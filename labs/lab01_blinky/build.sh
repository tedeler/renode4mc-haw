#!/bin/bash
set -e
source "$(dirname "$0")/../../scripts/env.sh"

LAB_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$LAB_DIR/build"

# Kompilieren und Linken als ELF-Datei für Cortex-M4F
"$TI_BIN/tiarmclang" \
    -mcpu=cortex-m4 \
    -mthumb \
    -mfloat-abi=hard \
    -mfpu=fpv4-sp-d16 \
    -O0 -g \
    -nostdlib \
    "$LAB_DIR/firmware/main.c" \
    "$LAB_DIR/firmware/tm4c1294.cmd" \
    -Wl,-e,Reset_Handler \
    -o "$LAB_DIR/build/blinky.elf"

echo "Build erfolgreich: $LAB_DIR/build/blinky.elf"
