/*
 * Lab 01 - Blinky: LED D1 und D2 abwechselnd blinken lassen (reiner Registerzugriff)
 * Board: EK-TM4C1294XL (TM4C1294NCPDT), Takt: 16 MHz (Reset-Takt, wird hier nicht verändert)
 *
 * LEDs auf dem Board:   D1 = PN1,  D2 = PN0
 *
 * Programmablauf:
 *   1. Takt für GPIO-Port N einschalten ("Clock Gating", Register RCGCGPIO)
 *   2. Warten, bis der Port bereit ist (Register PRGPIO)
 *   3. PN0 und PN1 als digitale Ausgänge konfigurieren (DIR, DEN)
 *   4. Endlosschleife: LEDs umschalten (DATA), dann warten
 *
 * Alle Adressen und Bitnummern stammen aus dem Datenblatt "TM4C1294NCPDT"
 * (Kapitel "System Control" und "General-Purpose Input/Outputs (GPIO)").
 */
#include <stdint.h>

/* Ein Register ist ein 32-Bit-Wert an einer festen Adresse. "volatile" verbietet dem
 * Compiler, Zugriffe wegzuoptimieren oder zu vertauschen. */
#define REG(adresse)        (*(volatile uint32_t *)(adresse))

/* System Control, Basisadresse 0x400FE000 */
#define SYSCTL_RCGCGPIO     REG(0x400FE000 + 0x608) /* Takt für GPIO-Ports (Bit n = Port n) */
#define SYSCTL_PRGPIO       REG(0x400FE000 + 0xA08) /* Peripheral Ready: Bit n = Port n bereit */

/* GPIO Port N (AHB-Adresse), Basisadresse 0x40064000 */
#define GPION_BASE          0x40064000u
#define GPION_DATA          REG(GPION_BASE + 0x3FC) /* Pegel der Pins 7..0 (alle Bits beschreibbar) */
#define GPION_DIR           REG(GPION_BASE + 0x400) /* 1 = Ausgang, 0 = Eingang */
#define GPION_DEN           REG(GPION_BASE + 0x51C) /* 1 = digitale Funktion eingeschaltet */

#define PORT_N              (1u << 12)        /* Port N ist Bit 12 in RCGCGPIO/PRGPIO */
#define PIN0                (1u << 0)
#define PIN1                (1u << 1)

/* Warteschleife: Dauer nur ungefähr, hängt vom Compiler ab (siehe README). */
#define HALBE_SEKUNDE       700000u

static void warten(uint32_t durchlaeufe)
{
    for (volatile uint32_t i = 0; i < durchlaeufe; i++)
    {
    }
}

int main(void)
{
    /* 1. Takt für Port N freigeben. Ohne diesen Schritt löst jeder Zugriff auf die
     *    Port-Register einen Fault aus (auf der Hardware: HardFault). */
    SYSCTL_RCGCGPIO |= PORT_N;

    /* 2. Warten, bis der Port nach dem Einschalten bereit ist. */
    while ((SYSCTL_PRGPIO & PORT_N) == 0)
    {
    }

    /* 3. PN0 und PN1 sind Ausgänge und digital. */
    GPION_DIR |= PIN0 | PIN1;
    GPION_DEN |= PIN0 | PIN1;

    /* Startzustand: D1 (PN1) an, D2 (PN0) aus. */
    GPION_DATA = PIN1;

    while (1)
    {
        warten(HALBE_SEKUNDE);

        /* Beide Pins umschalten: XOR invertiert genau die Bits, die in der Maske 1 sind. */
        GPION_DATA ^= PIN0 | PIN1;
    }
}
