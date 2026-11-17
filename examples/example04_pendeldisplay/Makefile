# Kommandozeilen-Build (Alternative zu CCS). Aufruf:  make
# Reiner Registerzugriff: keine TivaWare/driverlib nötig, Registernamen aus common/tm4c1294ncpdt.h.
# Compiler: TI Arm Clang (-> example04_pendeldisplay.out), sonst arm-none-eabi-gcc (-> example04_pendeldisplay.elf); wird gesucht,
# siehe ../../tools/tm4c.mk. Was gefunden wird:  make toolchain
SRCS = main.c

# Simulator: Dieses Beispiel braucht die Web-Konsole (Pendeldisplay, Sensor, UART im Browser):
#   cd ../../webconsole && docker compose up --build   ->  http://localhost:3000, Example 2, Programm hochladen
# "make sim" startet nur den einfachen Simulator (nur LED D2, kein Pendel).

include ../../tools/tm4c.mk
