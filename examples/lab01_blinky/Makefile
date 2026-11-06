# Kommandozeilen-Build mit TI Arm Clang (Alternative zu CCS). Aufruf:  make
# Variablen (anpassen oder beim Aufruf setzen, z. B.  make TIVAWARE_ROOT=~/ti/TivaWare...):
TIVAWARE_ROOT ?= $(HOME)/ti/TivaWare_C_Series-2.2.0.295
CCS_ROOT      ?= $(HOME)/ti/ccs2040/ccs
CGT           ?= $(lastword $(sort $(wildcard $(CCS_ROOT)/tools/compiler/ti-cgt-armllvm_*)))

CC     = $(CGT)/bin/tiarmclang
COMMON = ../../common
NAME   = $(notdir $(CURDIR))

CFLAGS = -mcpu=cortex-m4 -mfloat-abi=hard -mfpu=fpv4-sp-d16 -mthumb -Oz -g \
         -ffunction-sections -fdata-sections -Wall \
         -Dgcc -DPART_TM4C1294NCPDT -DTARGET_IS_TM4C129_RA1 -I$(TIVAWARE_ROOT)
LDFLAGS = -Wl,-c,$(COMMON)/tm4c1294.cmd -Wl,-m,$(NAME).map -Wl,--rom_model -Wl,--stack_size=2048 \
          -Wl,--reread_libs -Wl,--diag_suppress=10063 -Wl,--unused_section_elimination=on

SRCS = main.c $(COMMON)/startup_tm4c1294.c \
       $(addprefix $(TIVAWARE_ROOT)/driverlib/,gpio.c sysctl.c timer.c interrupt.c) $(COMMON)/cpu_clang.c

all: $(NAME).out

$(NAME).out: $(SRCS) $(COMMON)/tm4c1294.cmd
	$(CC) $(CFLAGS) $(SRCS) $(LDFLAGS) -o $@

# Im Simulator starten:  make sim
sim: $(NAME).out
	../../sim/ucsim $(NAME).out

clean:
	rm -f *.out *.map

.PHONY: all sim clean
