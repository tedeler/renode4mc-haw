# Gemeinsame Build-Regeln für TM4C1294-Programme (Beispiele, Musterlösungen, eigene Projekte).
# Eingebunden aus einem Projekt-Makefile, das vorher setzt:
#   SRCS       eigene .c-Dateien (Startup kommt automatisch dazu)
#   HDRS       eigene .h-Dateien (nur für Abhängigkeiten, optional)
#   HEAP_SIZE  Heap für printf()/malloc() beim TI-Build, z. B. 2048 (optional, sonst keiner)
#   NAME       Programmname (optional, Standard: Name des Projektordners)
#
# Compiler: Wo (und ob) der TI-Compiler installiert ist, ist nicht bekannt. Gesucht wird:
#   1. tiarmclang (TI Arm Clang, wie CCS)
#        TIARMCLANG=/pfad/tiarmclang  oder  CGT=/pfad/ti-cgt-armllvm_x.y  oder  CCS_ROOT=/pfad/ccs
#        sonst: tiarmclang im PATH, dann CCS bzw. Compiler unter ~/ti, ~/tmp/ti, /opt/ti, /Applications/ti
#        (bei mehreren Versionen gilt die neueste)            -> <NAME>.out
#   2. arm-none-eabi-gcc (wie tools/build-solutions.sh, newlib + printf über tools/gcc/cio_gcc.c)
#        ARM_GCC=/pfad/arm-none-eabi-gcc, sonst PATH, die gcc-Kopie aus CCS, xPack unter ~/.local/xPacks
#                                                             -> <NAME>.elf
# Erzwingen: make TOOLCHAIN=ti  bzw.  make TOOLCHAIN=gcc.  Anzeigen, was gefunden wird: make toolchain
# Beide Ergebnisse lassen sich in der Web-Konsole hochladen; aufs Board am besten den TI-Build (CCS).

comma       := ,
TM4C_MK_DIR := $(patsubst %/,%,$(dir $(lastword $(MAKEFILE_LIST))))
R4MC_ROOT   := $(patsubst %/,%,$(dir $(TM4C_MK_DIR)))
COMMON      ?= $(R4MC_ROOT)/common
GCC_DIR     ?= $(TM4C_MK_DIR)/gcc
NAME        ?= $(notdir $(CURDIR))

# ---- TI Arm Clang suchen --------------------------------------------------------------------------
TI_BASES = $(HOME)/ti $(HOME)/tmp/ti /opt/ti /Applications/ti
ifneq ($(CCS_ROOT),)
TI_CGT_DIRS = $(wildcard $(CCS_ROOT)/tools/compiler/ti-cgt-armllvm_*)
else
TI_CGT_DIRS = $(wildcard $(addsuffix /ccs*/ccs/tools/compiler/ti-cgt-armllvm_*,$(TI_BASES)) \
                         $(addsuffix /ti-cgt-armllvm_*,$(TI_BASES)))
endif
ifneq ($(CGT),)
TI_CGT_DIRS = $(CGT)
endif
# Neueste Version zuerst: nach dem Ordnernamen ti-cgt-armllvm_<Version> sortieren, nicht nach dem Pfad
TI_FOUND  = $(wildcard $(addsuffix /bin/tiarmclang,$(TI_CGT_DIRS)))
TI_NEWEST = $(lastword $(subst @, ,$(lastword $(sort $(foreach c,$(TI_FOUND),$(notdir $(c:%/bin/tiarmclang=%))@$(c))))))
ifndef TIARMCLANG
TIARMCLANG := $(firstword $(if $(CGT)$(CCS_ROOT),,$(shell command -v tiarmclang 2>/dev/null)) $(TI_NEWEST))
endif

# ---- arm-none-eabi-gcc suchen ---------------------------------------------------------------------
ifndef ARM_GCC
ARM_GCC := $(firstword $(shell command -v arm-none-eabi-gcc 2>/dev/null) \
             $(lastword $(sort $(wildcard $(addsuffix /ccs*/ccs/tools/compiler/gcc-arm-none-eabi*/bin/arm-none-eabi-gcc,$(TI_BASES))))) \
             $(lastword $(sort $(wildcard $(HOME)/.local/xPacks/@xpack-dev-tools/arm-none-eabi-gcc/*/.content/bin/arm-none-eabi-gcc))))
endif

TOOLCHAIN ?= $(if $(TIARMCLANG),ti,$(if $(ARM_GCC),gcc,keine))

# ---- Regeln ---------------------------------------------------------------------------------------
ALL_SRCS = $(SRCS) $(COMMON)/startup_tm4c1294.c
DEPS     = $(ALL_SRCS) $(HDRS) $(COMMON)/tm4c1294ncpdt.h

ifeq ($(TOOLCHAIN),ti)
TARGET  = $(NAME).out
CFLAGS  = -mcpu=cortex-m4 -mfloat-abi=hard -mfpu=fpv4-sp-d16 -mthumb -Oz -g -I. -I$(COMMON) \
          -ffunction-sections -fdata-sections -Wall
LDFLAGS = -Wl,-c,$(COMMON)/tm4c1294.cmd -Wl,-m,$(NAME).map -Wl,--rom_model -Wl,--stack_size=2048 \
          $(if $(HEAP_SIZE),-Wl$(comma)--heap_size=$(HEAP_SIZE)) \
          -Wl,--reread_libs -Wl,--diag_suppress=10063 -Wl,--unused_section_elimination=on
$(TARGET): $(DEPS) $(COMMON)/tm4c1294.cmd
	@test -x "$(TIARMCLANG)" || { echo "tiarmclang nicht gefunden ($(TIARMCLANG)) - TIARMCLANG, CGT oder CCS_ROOT setzen" >&2; exit 1; }
	@echo "[$(NAME)] TI Arm Clang: $(TIARMCLANG)"
	$(TIARMCLANG) $(CFLAGS) $(ALL_SRCS) $(LDFLAGS) -o $@
else ifeq ($(TOOLCHAIN),gcc)
TARGET  = $(NAME).elf
GCC_FLAGS = -mcpu=cortex-m4 -mthumb -mfloat-abi=soft -Os -g -Wall -nostartfiles --specs=nano.specs \
            -T $(GCC_DIR)/link.ld -I. -I$(COMMON)
$(TARGET): $(DEPS) $(GCC_DIR)/link.ld $(GCC_DIR)/crt.c $(GCC_DIR)/cio_gcc.c
	@test -x "$(ARM_GCC)" || { echo "arm-none-eabi-gcc nicht gefunden ($(ARM_GCC)) - ARM_GCC setzen" >&2; exit 1; }
	@echo "[$(NAME)] arm-none-eabi-gcc: $(ARM_GCC)"
	$(ARM_GCC) $(GCC_FLAGS) $(ALL_SRCS) $(GCC_DIR)/crt.c $(GCC_DIR)/cio_gcc.c -o $@
else
TARGET  = keine-toolchain
keine-toolchain:
	@echo "Kein Compiler gefunden: weder tiarmclang (TI Arm Clang/CCS) noch arm-none-eabi-gcc." >&2
	@echo "  TI:  make TIARMCLANG=/pfad/tiarmclang  (oder CGT=..., CCS_ROOT=...)" >&2
	@echo "  gcc: sudo apt install gcc-arm-none-eabi libnewlib-arm-none-eabi  (oder ARM_GCC=...)" >&2
	@exit 1
endif

all: $(TARGET)

# Nur der einfache Simulator (LEDs); Versuche mit weiterer Peripherie brauchen die Web-Konsole.
sim: $(TARGET)
	$(R4MC_ROOT)/sim/ucsim $(TARGET)

toolchain:
	@echo "TOOLCHAIN  = $(TOOLCHAIN)"
	@echo "TIARMCLANG = $(if $(TIARMCLANG),$(TIARMCLANG),(nicht gefunden))"
	@echo "ARM_GCC    = $(if $(ARM_GCC),$(ARM_GCC),(nicht gefunden))"
	@echo "COMMON     = $(COMMON)"

clean:
	rm -f *.out *.elf *.map

.PHONY: all sim toolchain clean keine-toolchain
.DEFAULT_GOAL := all
