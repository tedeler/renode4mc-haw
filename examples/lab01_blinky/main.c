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
 * Registernamen und Bitkonstanten stammen aus der TI-Headerdatei tm4c1294ncpdt.h
 * (common/). Sie enthält für jedes Register ein Makro <MODUL>_<REGISTER>_R, das direkt
 * wie eine Variable gelesen und beschrieben wird, z. B. GPIO_PORTN_DIR_R, und für die Bits
 * Konstanten wie SYSCTL_RCGCGPIO_R12 (Bit 12 = Port N). Im Programm steht deshalb keine
 * einzige Adresse; nachschlagen lassen sich die Register im Datenblatt "TM4C1294NCPDT"
 * (Kapitel "System Control" und "General-Purpose Input/Outputs (GPIO)").
 */
#include <stdint.h>
#include "tm4c1294ncpdt.h"

#define PORT_N              SYSCTL_RCGCGPIO_R12   /* Port N ist Bit 12 in RCGCGPIO */
#define PORT_N_BEREIT       SYSCTL_PRGPIO_R12     /* ... und in PRGPIO */
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
    SYSCTL_RCGCGPIO_R |= PORT_N;

    /* 2. Warten, bis der Port nach dem Einschalten bereit ist. */
    while ((SYSCTL_PRGPIO_R & PORT_N_BEREIT) == 0)
    {
    }

    /* 3. PN0 und PN1 sind Ausgänge und digital. */
    GPIO_PORTN_DIR_R |= PIN0 | PIN1;
    GPIO_PORTN_DEN_R |= PIN0 | PIN1;

    /* Startzustand: D1 (PN1) an, D2 (PN0) aus. */
    GPIO_PORTN_DATA_R = PIN1;

    while (1)
    {
        warten(HALBE_SEKUNDE);

        /* Beide Pins umschalten: XOR invertiert genau die Bits, die in der Maske 1 sind. */
        GPIO_PORTN_DATA_R ^= PIN0 | PIN1;
    }
}
