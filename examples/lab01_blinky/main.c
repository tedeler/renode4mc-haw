/*
 * Lab 01 - Blinky: LED D1 und D2 abwechselnd blinken lassen
 * Board: EK-TM4C1294XL (TM4C1294NCPDT), Takt: 16 MHz (Reset-Takt, wird hier nicht verändert)
 *
 * LEDs auf dem Board:   D1 = PN1,  D2 = PN0
 *
 * Programmablauf:
 *   1. Takt für GPIO-Port N einschalten ("Clock Gating")
 *   2. Warten, bis der Port bereit ist
 *   3. PN0 und PN1 als digitale Ausgänge konfigurieren
 *   4. Endlosschleife: LEDs umschalten, dann warten
 */
#include <stdint.h>
#include <stdbool.h>
#include "inc/hw_memmap.h"
#include "driverlib/gpio.h"
#include "driverlib/sysctl.h"

/* SysCtlDelay(n) braucht 3 Taktzyklen pro Durchlauf.
 * 16 MHz / 3 = ca. 5 333 333 Durchläufe pro Sekunde -> 0,5 s Pause: */
#define HALBE_SEKUNDE   (16000000u / 3u / 2u)

int main(void)
{
    /* 1. Takt für GPIO-Port N freigeben. Ohne diesen Schritt löst jeder Zugriff
     *    auf die Port-Register einen Fault aus (auf der Hardware: HardFault). */
    SysCtlPeripheralEnable(SYSCTL_PERIPH_GPION);

    /* 2. Warten, bis der Port nach dem Einschalten bereit ist. */
    while(!SysCtlPeripheralReady(SYSCTL_PERIPH_GPION))
    {
    }

    /* 3. PN0 und PN1 sind Ausgänge. */
    GPIOPinTypeGPIOOutput(GPIO_PORTN_BASE, GPIO_PIN_0 | GPIO_PIN_1);

    /* Startzustand: D1 (PN1) an, D2 (PN0) aus. */
    GPIOPinWrite(GPIO_PORTN_BASE, GPIO_PIN_0 | GPIO_PIN_1, GPIO_PIN_1);

    while(1)
    {
        SysCtlDelay(HALBE_SEKUNDE);

        /* Beide Pins umschalten: Lesen und mit XOR invertieren.
         * GPIOPinRead liefert nur die angefragten Pins (Maske). */
        uint32_t pins = GPIOPinRead(GPIO_PORTN_BASE, GPIO_PIN_0 | GPIO_PIN_1);
        GPIOPinWrite(GPIO_PORTN_BASE, GPIO_PIN_0 | GPIO_PIN_1, pins ^ (GPIO_PIN_0 | GPIO_PIN_1));
    }
}
