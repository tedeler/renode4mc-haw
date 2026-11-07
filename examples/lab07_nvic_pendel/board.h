/*
 * board.h - Takt und NVIC-Hilfen für dieses Lab.
 *
 * Alle Registernamen (..._R) und Bitkonstanten kommen aus der TI-Headerdatei tm4c1294ncpdt.h
 * (common/); hier wird KEINE Adresse und keine Konstante definiert, die es dort schon gibt.
 * Ports A-J heißen dort GPIO_PORTx_AHB_..._R (hier Port D), die Ports K-Q ohne AHB.
 * GPIO_PORTx_DATA_BITS_R[m]: Zugriff nur auf die Pins in Maske m (Adressmaskierung, Bits 9:2).
 */
#ifndef BOARD_H_
#define BOARD_H_

#include <stdint.h>
#include "tm4c1294ncpdt.h"

#define SYSTEM_CLOCK_HZ     16000000u
#define TAKTE_PRO_US        (SYSTEM_CLOCK_HZ / 1000000u)

/* NVIC: INT_... aus der Headerdatei ist die Nummer in der Vektortabelle; der NVIC zählt
 * ab dem ersten Peripherie-Interrupt (Eintrag 16). EN0 = IRQ 0..31, EN1 = IRQ 32..63. */
#define IRQ_GPIOD           (INT_GPIOD - 16u)     /*  3 */
#define IRQ_TIMER0A         (INT_TIMER0A - 16u)   /* 19 */
#define IRQ_TIMER2A         (INT_TIMER2A - 16u)   /* 23 */
#define IRQ_GPIOL           (INT_GPIOL - 16u)     /* 53 */

static inline void nvic_enable(uint32_t irq)
{
    if (irq < 32u) NVIC_EN0_R = 1u << irq;
    else NVIC_EN1_R = 1u << (irq - 32u);
}

#endif /* BOARD_H_ */
