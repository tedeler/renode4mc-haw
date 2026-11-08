/*
 * Testprogramm für test/e2e_step.js: CPU schläft (WFI) zwischen Interrupts.
 * Takt 16 MHz (Reset-Takt). Nicht für Studierende gedacht.
 *
 *   Timer0A   periodisch alle 1 ms -> TIMER0A_Handler: takte++, D1 (PN1) umschalten,
 *             takte auf PM0..PM7 ausgeben (Pendel-LEDs), jede 10. ms ein Zeichen auf UART0
 *   PL0       Sync des Pendels, beide Flanken -> GPIOL_Handler: syncFlanken++
 *   UART0     115200 8N1 mit FIFO, PA0/PA1. Nach jedem Aufwachen liest main empfangene Zeichen:
 *             's' hält Timer0 an (Antwort 'S'), 'g' startet ihn wieder (Antwort 'G')
 *   main      initialisiert und schläft danach nur noch (WFI)
 *             mit -DOHNE_WFI: wartet stattdessen aktiv (Normalbetrieb statt Schlaf), für
 *             test/e2e_cpustats.js
 *
 * Bauen (gcc wie tools/build-solutions.sh oder clang):
 *   arm-none-eabi-gcc -mcpu=cortex-m4 -mthumb -Os -g -nostartfiles -I common -T tools/gcc/link.ld \
 *       webconsole/backend/test/firmware/schlaf_takt.c common/startup_tm4c1294.c tools/gcc/crt.c -o schlaf_takt.elf
 *   clang --target=thumbv7em-none-eabi -mcpu=cortex-m4 -mfloat-abi=soft -Os -g -ffreestanding -nostdlib \
 *       -fuse-ld=lld -Wl,-e,_c_int00 -I common -T tools/gcc/link.ld <dieselben Quellen> -o schlaf_takt.elf
 */
#include <stdint.h>
#include "tm4c1294ncpdt.h"

#define SYSTEM_CLOCK_HZ 16000000u
#define IRQ_TIMER0A     (INT_TIMER0A - 16u)
#define IRQ_GPIOL       (INT_GPIOL - 16u)
#define PIN0            (1u << 0)
#define PIN1            (1u << 1)
#define PINS_UART0      (PIN0 | PIN1)
#define PCTL_UART0      0x00000011u
#define BAUD_IBRD       8u      /* 16 MHz / (16 * 115200) = 8,68 */
#define BAUD_FBRD       44u     /* 0,68 * 64 */
#define PORTS           (SYSCTL_RCGCGPIO_R0 | SYSCTL_RCGCGPIO_R10 | SYSCTL_RCGCGPIO_R11 | SYSCTL_RCGCGPIO_R12)
#define PORTS_BEREIT    (SYSCTL_PRGPIO_R0 | SYSCTL_PRGPIO_R10 | SYSCTL_PRGPIO_R11 | SYSCTL_PRGPIO_R12)

volatile uint32_t takte;        /* Timer-Interrupts seit Start */
volatile uint32_t syncFlanken;  /* Flanken an PL0 */
volatile uint32_t zeichen;      /* gesendete UART-Zeichen */
volatile uint32_t wachPhasen;   /* Durchläufe der Hauptschleife (= Aufwachen aus WFI) */

void TIMER0A_Handler(void)
{
    TIMER0_ICR_R = TIMER_ICR_TATOCINT;
    takte++;
    GPIO_PORTN_DATA_R ^= PIN1;
    GPIO_PORTM_DATA_R = takte & 0xFFu;
    if ((takte % 10u) == 0u)
    {
        UART0_DR_R = 'a' + (zeichen % 26u);
        zeichen++;
    }
}

void GPIOL_Handler(void)
{
    GPIO_PORTL_ICR_R = PIN0;
    syncFlanken++;
}

int main(void)
{
    SYSCTL_RCGCGPIO_R |= PORTS;
    SYSCTL_RCGCTIMER_R |= SYSCTL_RCGCTIMER_R0;
    SYSCTL_RCGCUART_R |= SYSCTL_RCGCUART_R0;
    while ((SYSCTL_PRGPIO_R & PORTS_BEREIT) != PORTS_BEREIT
           || (SYSCTL_PRTIMER_R & SYSCTL_PRTIMER_R0) == 0
           || (SYSCTL_PRUART_R & SYSCTL_PRUART_R0) == 0)
    {
    }

    GPIO_PORTN_DIR_R |= PIN1;
    GPIO_PORTN_DEN_R |= PIN1;
    GPIO_PORTN_DATA_R &= ~PIN1;
    GPIO_PORTM_DIR_R = 0xFFu;
    GPIO_PORTM_DEN_R = 0xFFu;

    /* PL0: Eingang, Interrupt bei beiden Flanken */
    GPIO_PORTL_DIR_R &= ~PIN0;
    GPIO_PORTL_DEN_R |= PIN0;
    GPIO_PORTL_IS_R &= ~PIN0;
    GPIO_PORTL_IBE_R |= PIN0;
    GPIO_PORTL_ICR_R = PIN0;
    GPIO_PORTL_IM_R |= PIN0;

    /* UART0 an PA0/PA1, 115200 8N1 */
    GPIO_PORTA_AHB_AFSEL_R |= PINS_UART0;
    GPIO_PORTA_AHB_PCTL_R = (GPIO_PORTA_AHB_PCTL_R & ~0xFFu) | PCTL_UART0;
    GPIO_PORTA_AHB_DEN_R |= PINS_UART0;
    UART0_CTL_R = 0;
    UART0_IBRD_R = BAUD_IBRD;
    UART0_FBRD_R = BAUD_FBRD;
    UART0_LCRH_R = UART_LCRH_WLEN_8 | UART_LCRH_FEN;
    UART0_CC_R = 0;
    UART0_CTL_R = UART_CTL_UARTEN | UART_CTL_TXE | UART_CTL_RXE;

    /* Timer0A: 32 Bit, periodisch, 1 ms */
    TIMER0_CTL_R = 0;
    TIMER0_CFG_R = TIMER_CFG_32_BIT_TIMER;
    TIMER0_TAMR_R = TIMER_TAMR_TAMR_PERIOD;
    TIMER0_TAILR_R = (SYSTEM_CLOCK_HZ / 1000u) - 1u;
    TIMER0_ICR_R = TIMER_ICR_TATOCINT;
    TIMER0_IMR_R |= TIMER_IMR_TATOIM;
    NVIC_EN0_R = 1u << IRQ_TIMER0A;
    NVIC_EN1_R = 1u << (IRQ_GPIOL - 32u);
    __asm volatile("cpsie i");
    TIMER0_CTL_R |= TIMER_CTL_TAEN;

    while (1)
    {
#ifdef OHNE_WFI
        __asm volatile("nop");
#else
        __asm volatile("wfi");
        wachPhasen++;
#endif
        while ((UART0_FR_R & UART_FR_RXFE) == 0)
        {
            uint32_t c = UART0_DR_R & 0xFFu;
            if (c == 's')
            {
                TIMER0_CTL_R &= ~TIMER_CTL_TAEN;
                UART0_DR_R = 'S';
            }
            else if (c == 'g')
            {
                TIMER0_CTL_R |= TIMER_CTL_TAEN;
                UART0_DR_R = 'G';
            }
        }
    }
}
