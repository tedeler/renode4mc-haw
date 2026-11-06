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
 *   4. Timer-Interrupt im Timer (GPTMIMR) und im NVIC (Interrupt-Controller, ISER0) freigeben
 *   5. Interrupt-Routine TIMER0A_Handler schaltet die LED um
 */
#include <stdint.h>

#define REG(adresse)        (*(volatile uint32_t *)(adresse))

#define SYSTEM_CLOCK_HZ     16000000u         /* Reset-Takt PIOSC */

/* System Control, Basisadresse 0x400FE000 */
#define SYSCTL_RCGCTIMER    REG(0x400FE000 + 0x604) /* Takt für Timer 0..7 (Bit n = Timer n) */
#define SYSCTL_RCGCGPIO     REG(0x400FE000 + 0x608) /* Takt für GPIO-Ports (Bit n = Port n) */
#define SYSCTL_PRTIMER      REG(0x400FE000 + 0xA04) /* Timer n bereit */
#define SYSCTL_PRGPIO       REG(0x400FE000 + 0xA08) /* Port n bereit */

/* GPIO Port N (AHB-Adresse) */
#define GPION_BASE          0x40064000u
#define GPION_DATA          REG(GPION_BASE + 0x3FC)
#define GPION_DIR           REG(GPION_BASE + 0x400)
#define GPION_DEN           REG(GPION_BASE + 0x51C)

/* General-Purpose Timer 0 */
#define TIMER0_BASE         0x40030000u
#define TIMER0_CFG          REG(TIMER0_BASE + 0x000) /* 0 = ein 32-Bit-Timer (Timer A) */
#define TIMER0_TAMR         REG(TIMER0_BASE + 0x004) /* Betriebsart Timer A */
#define TIMER0_CTL          REG(TIMER0_BASE + 0x00C) /* Steuerung, Bit 0 = TAEN (Start) */
#define TIMER0_IMR          REG(TIMER0_BASE + 0x018) /* Interrupt-Maske, Bit 0 = Timeout */
#define TIMER0_ICR          REG(TIMER0_BASE + 0x024) /* Interrupt-Flags löschen (1 schreiben) */
#define TIMER0_TAILR        REG(TIMER0_BASE + 0x028) /* Startwert (Reload) Timer A */

#define TAMR_PERIODISCH     0x2u              /* TAMR[1:0] = 2: periodischer Modus */
#define CTL_TAEN            (1u << 0)
#define IMR_TATOIM          (1u << 0)         /* Timer-A-Timeout-Interrupt */
#define ICR_TATOCINT        (1u << 0)

/* NVIC: Interrupt-Set-Enable-Register 0 (IRQ 0..31). Timer0A ist IRQ 19. */
#define NVIC_ISER0          REG(0xE000E100)
#define IRQ_TIMER0A         19u

#define PORT_N              (1u << 12)
#define PIN1                (1u << 1)

/* Der Name TIMER0A_Handler steht in der Vektortabelle (common/startup_tm4c1294.c). */
void TIMER0A_Handler(void)
{
    /* Interrupt-Flag löschen, sonst wird die Routine sofort erneut aufgerufen. */
    TIMER0_ICR = ICR_TATOCINT;

    /* LED D1 (PN1) umschalten. */
    GPION_DATA ^= PIN1;
}

int main(void)
{
    /* 1. Takt freigeben und auf "bereit" warten. */
    SYSCTL_RCGCGPIO |= PORT_N;
    SYSCTL_RCGCTIMER |= (1u << 0);
    while ((SYSCTL_PRGPIO & PORT_N) == 0 || (SYSCTL_PRTIMER & (1u << 0)) == 0)
    {
    }

    /* 2. PN1 = digitaler Ausgang, LED zunächst aus. */
    GPION_DIR |= PIN1;
    GPION_DEN |= PIN1;
    GPION_DATA &= ~PIN1;

    /* 3. Timer0A als 32-Bit-Timer, der periodisch von "Startwert" auf 0 herunterzählt.
     *    Reihenfolge laut Datenblatt: Timer aus -> CFG -> TAMR -> Startwert. */
    TIMER0_CTL = 0;
    TIMER0_CFG = 0;
    TIMER0_TAMR = TAMR_PERIODISCH;
    TIMER0_TAILR = (SYSTEM_CLOCK_HZ / 2u) - 1u;   /* 0,5 s */

    /* 4. Interrupt freigeben: erst im Timer, dann im NVIC, dann global. */
    TIMER0_ICR = ICR_TATOCINT;
    TIMER0_IMR |= IMR_TATOIM;
    NVIC_ISER0 = (1u << IRQ_TIMER0A);
    __asm volatile("cpsie i");

    /* 5. Timer starten. */
    TIMER0_CTL |= CTL_TAEN;

    while (1)
    {
        /* Hier könnte das eigentliche Programm laufen. Die CPU kann auch schlafen: */
        __asm volatile("wfi");
    }
}
