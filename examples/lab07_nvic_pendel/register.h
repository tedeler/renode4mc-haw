/*
 * register.h - die im Lab benutzten Register des TM4C1294NCPDT (reiner Registerzugriff,
 * Adressen aus dem Datenblatt SPMS433). Statt dieser Datei geht auch "inc/tm4c1294ncpdt.h".
 */
#ifndef REGISTER_H_
#define REGISTER_H_

#include <stdint.h>

#define REG(adresse)        (*(volatile uint32_t *)(adresse))
#define SYSTEM_CLOCK_HZ     16000000u
#define TAKTE_PRO_US        (SYSTEM_CLOCK_HZ / 1000000u)

/* System Control */
#define SYSCTL_RCGCTIMER    REG(0x400FE000 + 0x604)
#define SYSCTL_RCGCGPIO     REG(0x400FE000 + 0x608)
#define SYSCTL_PRTIMER      REG(0x400FE000 + 0xA04)
#define SYSCTL_PRGPIO       REG(0x400FE000 + 0xA08)

/* GPIO */
#define GPIO_DATA(base)     REG((base) + 0x3FC)
#define GPIO_DATA_M(base,m) REG((base) + ((m) << 2))
#define GPIO_DIR(base)      REG((base) + 0x400)
#define GPIO_IS(base)       REG((base) + 0x404)
#define GPIO_IBE(base)      REG((base) + 0x408)
#define GPIO_IEV(base)      REG((base) + 0x40C)
#define GPIO_IM(base)       REG((base) + 0x410)
#define GPIO_RIS(base)      REG((base) + 0x414)
#define GPIO_MIS(base)      REG((base) + 0x418)
#define GPIO_ICR(base)      REG((base) + 0x41C)
#define GPIO_DEN(base)      REG((base) + 0x51C)

#define GPIOD_BASE          0x4005B000u
#define GPIOL_BASE          0x40062000u
#define GPIOM_BASE          0x40063000u
#define PORT_D              (1u << 3)
#define PORT_L              (1u << 10)
#define PORT_M              (1u << 11)

/* General-Purpose Timer */
#define TIMER_CFG(base)     REG((base) + 0x000)
#define TIMER_TAMR(base)    REG((base) + 0x004)
#define TIMER_CTL(base)     REG((base) + 0x00C)
#define TIMER_IMR(base)     REG((base) + 0x018)
#define TIMER_ICR(base)     REG((base) + 0x024)
#define TIMER_TAILR(base)   REG((base) + 0x028)
#define TIMER_TAPR(base)    REG((base) + 0x038)
#define TIMER_TAV(base)     REG((base) + 0x050)

#define TIMER0_BASE         0x40030000u
#define TIMER1_BASE         0x40031000u
#define TIMER2_BASE         0x40032000u
#define TIMER_0             (1u << 0)
#define TIMER_1             (1u << 1)
#define TIMER_2             (1u << 2)

#define TIMER_CFG_32BIT     0x0u
#define TIMER_CFG_16BIT     0x4u
#define TIMER_TAMR_ONESHOT  0x1u
#define TIMER_TAMR_PERIODIC 0x2u
#define TIMER_CTL_TAEN      (1u << 0)
#define TIMER_IMR_TATOIM    (1u << 0)
#define TIMER_ICR_TATOCINT  (1u << 0)

/* NVIC: Interrupt-Nummern (Vektor - 16) und Freigabe */
#define NVIC_EN0            REG(0xE000E100)    /* IRQ 0..31 */
#define NVIC_EN1            REG(0xE000E104)    /* IRQ 32..63 */
#define IRQ_GPIOD           3u
#define IRQ_TIMER0A         19u
#define IRQ_TIMER2A         23u
#define IRQ_GPIOL           53u

static inline void nvic_enable(uint32_t irq)
{
    if (irq < 32u) NVIC_EN0 = 1u << irq;
    else NVIC_EN1 = 1u << (irq - 32u);
}

#endif /* REGISTER_H_ */
