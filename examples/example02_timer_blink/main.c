/*
 * Example 02 - Timer blink: LED D1 blinks, controlled by a timer interrupt (direct register access)
 * Board: EK-TM4C1294XL (TM4C1294NCPDT), clock: 16 MHz (clock after reset, not changed here)
 *
 * LED on the board:  D1 = PN1
 *
 * Idea: the CPU does not wait in a counting loop (as in Example 01); instead, Timer0 triggers
 * an interrupt every half second. Only the interrupt routine toggles the LED;
 * the main loop has nothing to do (other tasks could run here).
 *
 * Program flow:
 *   1. Switch on the clock of port N and Timer0 (RCGCGPIO, RCGCTIMER) and wait for "ready"
 *   2. Configure PN1 as an output
 *   3. Timer0A: 32 bit, periodic, start value = clock / 2 (0.5 s)
 *   4. Enable the timer interrupt in the timer (GPTMIMR) and in the NVIC (interrupt controller, EN0)
 *   5. The interrupt routine TIMER0A_Handler toggles the LED
 *
 * Register names and bit constants: TI header file tm4c1294ncpdt.h (common/), see Example 01.
 */
#include <stdint.h>
#include "tm4c1294ncpdt.h"

#define SYSTEM_CLOCK_HZ     16000000u         /* clock after reset: PIOSC */

/* Interrupt number for the NVIC: the header file counts the entries of the vector table
 * (INT_TIMER0A = 35). The first 16 entries belong to the processor (reset, HardFault, ...),
 * so in the NVIC, Timer0A is interrupt 35 - 16 = 19, i.e. bit 19 in EN0. */
#define IRQ_TIMER0A         (INT_TIMER0A - 16u)

#define PORT_N              SYSCTL_RCGCGPIO_R12
#define PIN1                (1u << 1)

/* The name TIMER0A_Handler is listed in the vector table (common/startup_tm4c1294.c). */
void TIMER0A_Handler(void)
{
    /* Clear the interrupt flag, otherwise the routine is called again immediately. */
    TIMER0_ICR_R = TIMER_ICR_TATOCINT;

    /* Toggle LED D1 (PN1). */
    GPIO_PORTN_DATA_R ^= PIN1;
}

int main(void)
{
    /* 1. Enable the clocks and wait for "ready". */
    SYSCTL_RCGCGPIO_R |= PORT_N;
    SYSCTL_RCGCTIMER_R |= SYSCTL_RCGCTIMER_R0;
    while ((SYSCTL_PRGPIO_R & SYSCTL_PRGPIO_R12) == 0 || (SYSCTL_PRTIMER_R & SYSCTL_PRTIMER_R0) == 0)
    {
    }

    /* 2. PN1 = digital output, LED off at first. */
    GPIO_PORTN_DIR_R |= PIN1;
    GPIO_PORTN_DEN_R |= PIN1;
    GPIO_PORTN_DATA_R &= ~PIN1;

    /* 3. Timer0A as a 32-bit timer that periodically counts down from the "start value" to 0.
     *    Order according to the data sheet: timer off -> CFG -> TAMR -> start value. */
    TIMER0_CTL_R = 0;
    TIMER0_CFG_R = TIMER_CFG_32_BIT_TIMER;
    TIMER0_TAMR_R = TIMER_TAMR_TAMR_PERIOD;
    TIMER0_TAILR_R = (SYSTEM_CLOCK_HZ / 2u) - 1u;   /* 0.5 s */

    /* 4. Enable the interrupt: first in the timer, then in the NVIC, then globally. */
    TIMER0_ICR_R = TIMER_ICR_TATOCINT;
    TIMER0_IMR_R |= TIMER_IMR_TATOIM;
    NVIC_EN0_R = 1u << IRQ_TIMER0A;
    __asm volatile("cpsie i");

    /* 5. Start the timer. */
    TIMER0_CTL_R |= TIMER_CTL_TAEN;

    while (1)
    {
        /* The actual program could run here. The CPU can also sleep: */
        __asm volatile("wfi");
    }
}
