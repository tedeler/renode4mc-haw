# Kommandozeilen-Build mit TI Arm Clang (Alternative zu CCS). Aufruf:  make
# Reiner Registerzugriff: keine TivaWare/driverlib nötig.
# Variable (anpassen oder beim Aufruf setzen, z. B.  make CCS_ROOT=/opt/ti/ccs):
CCS_ROOT      ?= $(HOME)/ti/ccs2040/ccs
CGT           ?= $(lastword $(sort $(wildcard $(CCS_ROOT)/tools/compiler/ti-cgt-armllvm_*)))

CC     = $(CGT)/bin/tiarmclang
COMMON = ../../common
NAME   = $(notdir $(CURDIR))

CFLAGS = -mcpu=cortex-m4 -mfloat-abi=hard -mfpu=fpv4-sp-d16 -mthumb -Oz -g \
         -ffunction-sections -fdata-sections -Wall
LDFLAGS = -Wl,-c,$(COMMON)/tm4c1294.cmd -Wl,-m,$(NAME).map -Wl,--rom_model -Wl,--stack_size=2048 \
          -Wl,--reread_libs -Wl,--diag_suppress=10063 -Wl,--unused_section_elimination=on

SRCS = main.c $(COMMON)/startup_tm4c1294.c

all: $(NAME).out

$(NAME).out: $(SRCS) $(COMMON)/tm4c1294.cmd
	$(CC) $(CFLAGS) $(SRCS) $(LDFLAGS) -o $@

# Simulator: Dieses Lab braucht die Web-Konsole (OLED, Sensor, Keypad, UART im Browser):
#   cd ../../webconsole && docker compose up --build   ->  http://localhost:3000, Versuch 1, $(NAME).out hochladen
# "make sim" startet nur den einfachen Simulator (LEDs im Browser, keine weiteren Bedienelemente).
sim: $(NAME).out
	../../sim/ucsim $(NAME).out

clean:
	rm -f *.out *.map

.PHONY: all sim clean
