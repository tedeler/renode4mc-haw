/*
 * Example 01 - Blinky: LEDs D1 and D2 blink alternately (direct register access)
 * Board: EK-TM4C1294XL (TM4C1294NCPDT), clock: 16 MHz (clock after reset, not changed here)
 *
 * LEDs on the board:   D1 = PN1,  D2 = PN0
 *
 * Program flow:
 *   1. Switch on the clock of GPIO port N ("clock gating", register RCGCGPIO)
 *   2. Wait until the port is ready (register PRGPIO)
 *   3. Configure PN0 and PN1 as digital outputs (DIR, DEN)
 *   4. Endless loop: toggle the LEDs (DATA), then wait
 *
 * Register names and bit constants come from the TI header file tm4c1294ncpdt.h
 * (common/). For every register it contains a macro <MODULE>_<REGISTER>_R that can be read
 * and written directly like a variable, e.g. GPIO_PORTN_DIR_R, and for the bits it contains
 * constants such as SYSCTL_RCGCGPIO_R12 (bit 12 = port N). That is why the program does not
 * contain a single address; you can look up the registers in the data sheet "TM4C1294NCPDT"
 * (chapters "System Control" and "General-Purpose Input/Outputs (GPIO)").
 */
#include <stdint.h>
#include "tm4c1294ncpdt.h"

#define PORT_N              SYSCTL_RCGCGPIO_R12   /* port N is bit 12 in RCGCGPIO */
#define PORT_N_READY        SYSCTL_PRGPIO_R12     /* ... and in PRGPIO */
#define PIN0                (1u << 0)
#define PIN1                (1u << 1)

/* Busy-wait loop: the duration is only approximate, it depends on the compiler (see README). */
#define HALF_SECOND         700000u

static void delay(uint32_t loops)
{
    for (volatile uint32_t i = 0; i < loops; i++)
    {
    }
}

int main(void)
{
    /* 1. Enable the clock of port N. Without this step, every access to the port
     *    registers causes a fault (on the hardware: HardFault). */
    SYSCTL_RCGCGPIO_R |= PORT_N;

    /* 2. Wait until the port is ready after being switched on. */
    while ((SYSCTL_PRGPIO_R & PORT_N_READY) == 0)
    {
    }

    /* 3. PN0 and PN1 are outputs and digital. */
    GPIO_PORTN_DIR_R |= PIN0 | PIN1;
    GPIO_PORTN_DEN_R |= PIN0 | PIN1;

    /* Initial state: D1 (PN1) on, D2 (PN0) off. */
    GPIO_PORTN_DATA_R = PIN1;

    while (1)
    {
        delay(HALF_SECOND);

        /* Toggle both pins: XOR inverts exactly those bits that are 1 in the mask. */
        GPIO_PORTN_DATA_R ^= PIN0 | PIN1;
    }
}
