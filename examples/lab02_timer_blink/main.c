/*
 * Lab 02 - Timer-Blink: LED D1 blinkt, gesteuert von einem Timer-Interrupt (reiner Registerzugriff)
 * Board: EK-TM4C1294XL (TM4C1294NCPDT), Takt: 16 MHz (Reset-Takt, wird hier nicht verändert)
 *
 * LED auf dem Board:  D1 = PN1
 *
 * Idee: Die CPU wartet nicht in einer Zählschleife (wie in Lab 01), sondern Timer0 löst
 * jede halbe Sekunde einen Interrupt aus. Nur die Interrupt-Routine schaltet die LED um;
 * die Hauptschleife hat nichts zu tun (hier könnten andere Aufgaben stehen).
 *
 * Ablauf:
 *   1. Takt für Port N und Timer0 einschalten (RCGCGPIO, RCGCTIMER) und auf "bereit" warten
 *   2. PN1 als Ausgang konfigurieren
 *   3. Timer0A: 32 Bit, periodisch, Startwert = Takt / 2 (0,5 s)
 *   4. Timer-Interrupt im Timer (GPTMIMR) und im NVIC (Interrupt-Controller, EN0) freigeben
 *   5. Interrupt-Routine TIMER0A_Handler schaltet die LED um
 *
 * Registernamen und Bitkonstanten: TI-Headerdatei tm4c1294ncpdt.h (common/), siehe Lab 01.
 */
#include <stdint.h>
#include "tm4c1294ncpdt.h"

#define SYSTEM_CLOCK_HZ     16000000u         /* Reset-Takt PIOSC */

/* Interrupt-Nummer für den NVIC: Die Headerdatei zählt die Einträge der Vektortabelle
 * (INT_TIMER0A = 35). Die ersten 16 Einträge gehören zum Prozessor (Reset, HardFault, ...),
 * deshalb ist Timer0A im NVIC der Interrupt 35 - 16 = 19, also Bit 19 in EN0. */
#define IRQ_TIMER0A         (INT_TIMER0A - 16u)

#define PORT_N              SYSCTL_RCGCGPIO_R12
#define PIN1                (1u << 1)

/* Der Name TIMER0A_Handler steht in der Vektortabelle (common/startup_tm4c1294.c). */
void TIMER0A_Handler(void)
{
    /* Interrupt-Flag löschen, sonst wird die Routine sofort erneut aufgerufen. */
    TIMER0_ICR_R = TIMER_ICR_TATOCINT;

    /* LED D1 (PN1) umschalten. */
    GPIO_PORTN_DATA_R ^= PIN1;
}

int main(void)
{
    /* 1. Takt freigeben und auf "bereit" warten. */
    SYSCTL_RCGCGPIO_R |= PORT_N;
    SYSCTL_RCGCTIMER_R |= SYSCTL_RCGCTIMER_R0;
    while ((SYSCTL_PRGPIO_R & SYSCTL_PRGPIO_R12) == 0 || (SYSCTL_PRTIMER_R & SYSCTL_PRTIMER_R0) == 0)
    {
    }

    /* 2. PN1 = digitaler Ausgang, LED zunächst aus. */
    GPIO_PORTN_DIR_R |= PIN1;
    GPIO_PORTN_DEN_R |= PIN1;
    GPIO_PORTN_DATA_R &= ~PIN1;

    /* 3. Timer0A als 32-Bit-Timer, der periodisch von "Startwert" auf 0 herunterzählt.
     *    Reihenfolge laut Datenblatt: Timer aus -> CFG -> TAMR -> Startwert. */
    TIMER0_CTL_R = 0;
    TIMER0_CFG_R = TIMER_CFG_32_BIT_TIMER;
    TIMER0_TAMR_R = TIMER_TAMR_TAMR_PERIOD;
    TIMER0_TAILR_R = (SYSTEM_CLOCK_HZ / 2u) - 1u;   /* 0,5 s */

    /* 4. Interrupt freigeben: erst im Timer, dann im NVIC, dann global. */
    TIMER0_ICR_R = TIMER_ICR_TATOCINT;
    TIMER0_IMR_R |= TIMER_IMR_TATOIM;
    NVIC_EN0_R = 1u << IRQ_TIMER0A;
    __asm volatile("cpsie i");

    /* 5. Timer starten. */
    TIMER0_CTL_R |= TIMER_CTL_TAEN;

    while (1)
    {
        /* Hier könnte das eigentliche Programm laufen. Die CPU kann auch schlafen: */
        __asm volatile("wfi");
    }
}
