TI_BIN ?= $(HOME)/tmp/ti/ccs2040/ccs/tools/compiler/ti-cgt-armllvm_4.0.4.LTS/bin
CC = $(TI_BIN)/tiarmclang

BUILD_DIR = build
FW_DIR = firmware
TARGET = $(BUILD_DIR)/blinky.elf

CFLAGS = -mcpu=cortex-m4 -mthumb -mfloat-abi=hard -mfpu=fpv4-sp-d16 -O0 -g -nostdlib
LDFLAGS = $(FW_DIR)/tm4c1294.cmd -Wl,-e,Reset_Handler

SRCS = $(FW_DIR)/main.c

.PHONY: all sim clean

all: $(TARGET)

$(TARGET): $(SRCS)
	@mkdir -p $(BUILD_DIR)
	$(CC) $(CFLAGS) $^ $(LDFLAGS) -o $@

sim: all
	@bash -c "source ../../scripts/env.sh && renode --console sim.resc"

clean:
	rm -rf $(BUILD_DIR)
