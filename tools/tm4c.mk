# Common build rules for TM4C1294 programs (examples, reference solutions, your own projects).
# Included from a project Makefile that sets beforehand:
#   SRCS       your own .c files (the start-up code is added automatically)
#   HDRS       your own .h files (only for dependencies, optional)
#   HEAP_SIZE  heap for printf()/malloc() in the TI build, e.g. 2048 (optional, otherwise none)
#   NAME       program name (optional, default: name of the project folder)
#
# Compiler: where (and whether) the TI compiler is installed is not known. It is searched like this:
#   1. tiarmclang (TI Arm Clang, as in CCS)
#        TIARMCLANG=/path/tiarmclang  or  CGT=/path/ti-cgt-armllvm_x.y  or  CCS_ROOT=/path/ccs
#        otherwise: tiarmclang in PATH, then CCS or the compiler in ~/ti, ~/tmp/ti, /opt/ti, /Applications/ti
#        (if there are several versions, the newest one is used)  -> <NAME>.out
#   2. arm-none-eabi-gcc (as tools/build-solutions.sh, newlib + printf via tools/gcc/cio_gcc.c)
#        ARM_GCC=/path/arm-none-eabi-gcc, otherwise PATH, the gcc copy in CCS, xPack in ~/.local/xPacks
#                                                             -> <NAME>.elf
# Force one: make TOOLCHAIN=ti  or  make TOOLCHAIN=gcc.  Show what is found: make toolchain
# Both results can be uploaded to the web console; for the board, the TI build (CCS) is best.

comma       := ,
TM4C_MK_DIR := $(patsubst %/,%,$(dir $(lastword $(MAKEFILE_LIST))))
R4MC_ROOT   := $(patsubst %/,%,$(dir $(TM4C_MK_DIR)))
COMMON      ?= $(R4MC_ROOT)/common
GCC_DIR     ?= $(TM4C_MK_DIR)/gcc
NAME        ?= $(notdir $(CURDIR))

# ---- find TI Arm Clang ---------------------------------------------------------------------------
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
# Newest version first: sort by the folder name ti-cgt-armllvm_<version>, not by the path
TI_FOUND  = $(wildcard $(addsuffix /bin/tiarmclang,$(TI_CGT_DIRS)))
TI_NEWEST = $(lastword $(subst @, ,$(lastword $(sort $(foreach c,$(TI_FOUND),$(notdir $(c:%/bin/tiarmclang=%))@$(c))))))
ifndef TIARMCLANG
TIARMCLANG := $(firstword $(if $(CGT)$(CCS_ROOT),,$(shell command -v tiarmclang 2>/dev/null)) $(TI_NEWEST))
endif

# ---- find arm-none-eabi-gcc ----------------------------------------------------------------------
ifndef ARM_GCC
ARM_GCC := $(firstword $(shell command -v arm-none-eabi-gcc 2>/dev/null) \
             $(lastword $(sort $(wildcard $(addsuffix /ccs*/ccs/tools/compiler/gcc-arm-none-eabi*/bin/arm-none-eabi-gcc,$(TI_BASES))))) \
             $(lastword $(sort $(wildcard $(HOME)/.local/xPacks/@xpack-dev-tools/arm-none-eabi-gcc/*/.content/bin/arm-none-eabi-gcc))))
endif

TOOLCHAIN ?= $(if $(TIARMCLANG),ti,$(if $(ARM_GCC),gcc,none))

# ---- rules -----------------------------------------------------------------------------------------
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
	@test -x "$(TIARMCLANG)" || { echo "tiarmclang not found ($(TIARMCLANG)) - set TIARMCLANG, CGT or CCS_ROOT" >&2; exit 1; }
	@echo "[$(NAME)] TI Arm Clang: $(TIARMCLANG)"
	$(TIARMCLANG) $(CFLAGS) $(ALL_SRCS) $(LDFLAGS) -o $@
else ifeq ($(TOOLCHAIN),gcc)
TARGET  = $(NAME).elf
GCC_FLAGS = -mcpu=cortex-m4 -mthumb -mfloat-abi=soft -Os -g -Wall -nostartfiles --specs=nano.specs \
            -T $(GCC_DIR)/link.ld -I. -I$(COMMON)
$(TARGET): $(DEPS) $(GCC_DIR)/link.ld $(GCC_DIR)/crt.c $(GCC_DIR)/cio_gcc.c
	@test -x "$(ARM_GCC)" || { echo "arm-none-eabi-gcc not found ($(ARM_GCC)) - set ARM_GCC" >&2; exit 1; }
	@echo "[$(NAME)] arm-none-eabi-gcc: $(ARM_GCC)"
	$(ARM_GCC) $(GCC_FLAGS) $(ALL_SRCS) $(GCC_DIR)/crt.c $(GCC_DIR)/cio_gcc.c -o $@
else
TARGET  = no-toolchain
no-toolchain:
	@echo "No compiler found: neither tiarmclang (TI Arm Clang/CCS) nor arm-none-eabi-gcc." >&2
	@echo "  TI:  make TIARMCLANG=/path/tiarmclang  (or CGT=..., CCS_ROOT=...)" >&2
	@echo "  gcc: sudo apt install gcc-arm-none-eabi libnewlib-arm-none-eabi  (or ARM_GCC=...)" >&2
	@exit 1
endif

all: $(TARGET)

# Only the simple simulator (LEDs); experiments with more peripherals need the web console.
sim: $(TARGET)
	$(R4MC_ROOT)/sim/ucsim $(TARGET)

toolchain:
	@echo "TOOLCHAIN  = $(TOOLCHAIN)"
	@echo "TIARMCLANG = $(if $(TIARMCLANG),$(TIARMCLANG),(not found))"
	@echo "ARM_GCC    = $(if $(ARM_GCC),$(ARM_GCC),(not found))"
	@echo "COMMON     = $(COMMON)"

clean:
	rm -f *.out *.elf *.map

.PHONY: all sim toolchain clean no-toolchain
.DEFAULT_GOAL := all
