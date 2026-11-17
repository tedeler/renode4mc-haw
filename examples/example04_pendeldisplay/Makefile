# Command-line build (alternative to CCS). Usage:  make
# Direct register access: no TivaWare/driverlib needed, register names from common/tm4c1294ncpdt.h.
# Compiler: TI Arm Clang (-> example04_pendeldisplay.out), otherwise arm-none-eabi-gcc (-> example04_pendeldisplay.elf); it is searched for,
# see ../../tools/tm4c.mk. Which one is found:  make toolchain
SRCS = main.c

# Simulator: this example needs the web console (pendulum display, sensor, UART in the browser):
#   cd ../../webconsole && docker compose up --build   ->  http://localhost:3000, Example 2, upload the program
# "make sim" only starts the simple simulator (only LED D2, no pendulum).

include ../../tools/tm4c.mk
