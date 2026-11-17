# Command-line build (alternative to CCS). Usage:  make
# Direct register access: no TivaWare/driverlib needed, register names from common/tm4c1294ncpdt.h.
# Compiler: TI Arm Clang (-> example02_timer_blink.out), otherwise arm-none-eabi-gcc (-> example02_timer_blink.elf); it is searched for,
# see ../../tools/tm4c.mk. Which one is found:  make toolchain
SRCS = main.c

# Run in the simulator:  make sim

include ../../tools/tm4c.mk
