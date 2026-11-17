# Kommandozeilen-Build (Alternative zu CCS). Aufruf:  make
# Reiner Registerzugriff: keine TivaWare/driverlib nötig, Registernamen aus common/tm4c1294ncpdt.h.
# Compiler: TI Arm Clang (-> example03_webkonsole.out), sonst arm-none-eabi-gcc (-> example03_webkonsole.elf); wird gesucht,
# siehe ../../tools/tm4c.mk. Was gefunden wird:  make toolchain
SRCS = main.c

# Simulator: Dieses Beispiel braucht die Web-Konsole (OLED, Sensor, Keypad, UART im Browser):
#   cd ../../webconsole && docker compose up --build   ->  http://localhost:3000, Example 1, Programm hochladen
# "make sim" startet nur den einfachen Simulator (LEDs im Browser, keine weiteren Bedienelemente).

include ../../tools/tm4c.mk
