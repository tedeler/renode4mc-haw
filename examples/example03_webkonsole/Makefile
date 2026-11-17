# Command-line build (alternative to CCS). Usage:  make
# Direct register access: no TivaWare/driverlib needed, register names from common/tm4c1294ncpdt.h.
# Compiler: TI Arm Clang (-> example03_webkonsole.out), otherwise arm-none-eabi-gcc (-> example03_webkonsole.elf); it is searched for,
# see ../../tools/tm4c.mk. Which one is found:  make toolchain
SRCS = main.c

# Simulator: this example needs the web console (OLED, sensor, keypad, UART in the browser):
#   cd ../../webconsole && docker compose up --build   ->  http://localhost:3000, Example 1, upload the program
# "make sim" only starts the simple simulator (LEDs in the browser, no other controls).

include ../../tools/tm4c.mk
