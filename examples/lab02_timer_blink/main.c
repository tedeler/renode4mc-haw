/*
 * Lab 02 - Timer-Blink: LED D1 blinkt, gesteuert von einem Timer-Interrupt
 * Board: EK-TM4C1294XL (TM4C1294NCPDT), Takt: 16 MHz (Reset-Takt, wird hier nicht verändert)
 *
 * LED auf dem Board:  D1 = PN1
 *
 * Idee: Die CPU wartet nicht in einer Zählschleife (wie in Lab 01), sondern Timer0 löst
 * jede halbe Sekunde einen Interrupt aus. Nur die Interrupt-Routine schaltet die LED um;
 * die Hauptschleife hat nichts zu tun (hier könnten andere Aufgaben stehen).
 *
 * Ablauf:
 *   1. Takt für Port N und Timer0 einschalten (Clock Gating)
 *   2. PN1 als Ausgang konfigurieren
 *   3. Timer0A: 32 Bit, periodisch, Startwert = Takt / 2 (0,5 s)
 *   4. Timer-Interrupt im Timer und im NVIC (Interrupt-Controller) freigeben
 *   5. Interrupt-Routine TIMER0A_Handler schaltet die LED um
 */
#include <stdint.h>
#include <stdbool.h>
#include "inc/hw_ints.h"
#include "inc/hw_memmap.h"
#include "driverlib/gpio.h"
#include "driverlib/interrupt.h"
#include "driverlib/sysctl.h"
#include "driverlib/timer.h"

#define SYSTEM_CLOCK_HZ   16000000u   /* Reset-Takt PIOSC */

/* Der Name TIMER0A_Handler steht in der Vektortabelle (common/startup_tm4c1294.c). */
void TIMER0A_Handler(void)
{
    /* Interrupt-Flag löschen, sonst wird die Routine sofort erneut aufgerufen. */
    TimerIntClear(TIMER0_BASE, TIMER_TIMA_TIMEOUT);

    /* LED D1 (PN1) umschalten. */
    uint32_t pin = GPIOPinRead(GPIO_PORTN_BASE, GPIO_PIN_1);
    GPIOPinWrite(GPIO_PORTN_BASE, GPIO_PIN_1, pin ^ GPIO_PIN_1);
}

int main(void)
{
    /* 1. Takt freigeben und auf "bereit" warten. */
    SysCtlPeripheralEnable(SYSCTL_PERIPH_GPION);
    SysCtlPeripheralEnable(SYSCTL_PERIPH_TIMER0);
    while(!SysCtlPeripheralReady(SYSCTL_PERIPH_GPION) ||
          !SysCtlPeripheralReady(SYSCTL_PERIPH_TIMER0))
    {
    }

    /* 2. PN1 = Ausgang. */
    GPIOPinTypeGPIOOutput(GPIO_PORTN_BASE, GPIO_PIN_1);

    /* 3. Timer0A als 32-Bit-Timer, der periodisch von "Startwert" auf 0 herunterzählt. */
    TimerConfigure(TIMER0_BASE, TIMER_CFG_PERIODIC);
    TimerLoadSet(TIMER0_BASE, TIMER_A, (SYSTEM_CLOCK_HZ / 2u) - 1u);   /* 0,5 s */

    /* 4. Interrupt freigeben: erst im Timer, dann im NVIC, dann global. */
    TimerIntEnable(TIMER0_BASE, TIMER_TIMA_TIMEOUT);
    IntEnable(INT_TIMER0A);
    IntMasterEnable();

    /* 5. Timer starten. */
    TimerEnable(TIMER0_BASE, TIMER_A);

    while(1)
    {
        /* Hier könnte das eigentliche Programm laufen. Die CPU kann auch schlafen: */
        __asm volatile("wfi");
    }
}
