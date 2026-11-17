/*
 * Example 05 - Timer with CCP pins: PWM and pulse in compare mode, key press duration in capture mode
 * Board: EK-TM4C1294XL (TM4C1294NCPDT), clock: 16 MHz (clock after reset, not changed here)
 * Experiment in the web console: "example3"
 *
 *   Component    Pin  Function                 Use in the program
 *   ------------ ---- ------------------------ -----------------------------------------------------
 *   LED1         PL4  T0CCP0 (GPIOPCTL = 3)    PWM approx. 30 Hz, duty cycle 0/25/50/100 % (Timer0A)
 *   LED2         PL6  T1CCP0 (GPIOPCTL = 3)    pulse 100 ms HIGH every 1 s (Timer1A)
 *   LED3, LED4   PL0, PL1  GPIO output         selected step in binary (00 = 0 %, 01 = 25 %, 10 = 50 %, 11 = 100 %)
 *   Key 0        PM0  T2CCP0 (GPIOPCTL = 3)    0 %; Timer2A measures how long it is pressed (capture)
 *   Key 1..3     PM1..PM3  GPIO input          25 %, 50 %, 100 % (GPIO interrupt, falling edge)
 *   UART0        PA0/PA1   U0RX/U0TX           115200 bit/s 8N1: step and measured key press duration
 *   Push buttons to GND, internal pull-ups (GPIOPUR): pressed = LOW.
 *
 * Timer0 and Timer1: 16-bit mode (GPTMCFG = 0x4), periodic, counting down, "Timer Compare Action Mode"
 * (data sheet 13.3.3.1, field TCACT in GPTMTnMR): at the time-out the hardware sets or clears the
 * CCP pin – the level change happens at exactly the right clock cycle, even if the CPU is busy with
 * something else. The interrupt routine always schedules the phase after the next one:
 *
 *     Phase n           | Phase n+1          | Phase n+2
 *     ------------------+--------------------+-------------------
 *                       ^ time-out: pin = action from TCACT, counter loads TnILR (written in phase n)
 *                         ISR: TCACT  = level of phase n+2 (takes effect at the next time-out)
 *                              TnILR  = duration of phase n+2 (TnILD = 1: only loaded at the next
 *                                       time-out, the running phase is not disturbed)
 *
 *   Timer0A: prescaler 16 -> 1 tick = 1 us, period 33 333 us (30 Hz). At 30 Hz an LED only flickers
 *            slightly, the eye sees it dimmed.
 *   Timer1A: prescaler 256 -> 1 tick = 16 us, period 62 500 ticks = 1 s, of which 6 250 = 100 ms HIGH.
 *   (In 16-bit mode counting down, the prescaler is a true divider: period = (TnILR+1)*(TnPR+1).)
 *
 * Timer2: timer A in "Input Edge-Time Mode" (13.3.3.4) on T2CCP0 = PM0 (key 0), both edges.
 *   On every edge the hardware stores the counter value in GPTMTAR and sets CAERIS. 16 bits
 *   plus the prescaler as extension = 24-bit counter, counting down from 0xFF.FFFF; it overflows after
 *   2^24 ticks = 1.048576 s. For longer key presses, timer B (periodic, same period
 *   (0xFFFF+1)*(0xFF+1) = 2^24 ticks, started in the same clock cycle) counts the overflows – as
 *   recommended by the note on figure 13-3 in the data sheet. For this, Timer2B has a higher priority than Timer2A.
 *   Resolution 62.5 ns (1 clock cycle), range up to 268 s.
 *
 * Register names and bit constants: TI header file tm4c1294ncpdt.h (common/), no addresses of our own.
 */
#include <stdint.h>
#include <stdbool.h>
#include "tm4c1294ncpdt.h"

/* ---------------------------------------------------------------------------------------------
 * Constants that the header file does not know
 * ------------------------------------------------------------------------------------------- */
#define SYSTEM_CLOCK_HZ     16000000u            /* clock after reset: PIOSC */
#define TICKS_PER_US        (SYSTEM_CLOCK_HZ / 1000000u)

/* GPIOPCTL: 4 bits per pin (data sheet table 10-2) */
#define PCTL_MASK(pin)     (0xFu << (4u * (pin)))
#define PCTL_FUNCTION(pin, f) ((uint32_t)(f) << (4u * (pin)))
#define PCTL_UART0          1u                   /* PA0 = U0RX, PA1 = U0TX */
#define PCTL_CCP            3u                   /* PL4 = T0CCP0, PL6 = T1CCP0, PM0 = T2CCP0 */

/* NVIC: number in the vector table (INT_...) minus 16 */
#define IRQ_TIMER0A         (INT_TIMER0A - 16u)  /* 19 */
#define IRQ_TIMER1A         (INT_TIMER1A - 16u)  /* 21 */
#define IRQ_TIMER2A         (INT_TIMER2A - 16u)  /* 23 */
#define IRQ_TIMER2B         (INT_TIMER2B - 16u)  /* 24 */
#define IRQ_GPIOM           (INT_GPIOM - 16u)    /* 72 -> EN2 bit 8 */

/* Pins */
#define LED1                (1u << 4)            /* PL4 = T0CCP0 */
#define LED2                (1u << 6)            /* PL6 = T1CCP0 */
#define LED3                (1u << 0)            /* PL0 */
#define LED4                (1u << 1)            /* PL1 */
#define KEY0              (1u << 0)            /* PM0 = T2CCP0 */
#define KEY1              (1u << 1)            /* PM1 */
#define KEY2              (1u << 2)            /* PM2 */
#define KEY3              (1u << 3)            /* PM3 */
#define KEYS_GPIO         (KEY1 | KEY2 | KEY3)
#define PINS_UART0          0x03u                /* PA0, PA1 */

/* Timer0A: PWM ("dimming" LED1) */
#define DIM_PRESCALER       (TICKS_PER_US - 1u)  /* 16 clock cycles = 1 us */
#define DIM_PERIOD_US      33333u               /* 30 Hz */

/* Timer1A: pulse */
#define PULSE_PRESCALER      255u                 /* 256 clock cycles = 16 us */
#define PULSE_TICK_US        16u
#define PULSE_PERIOD        (1000000u / PULSE_TICK_US)   /* 1 s   = 62 500 */
#define PULSE_HIGH           (100000u / PULSE_TICK_US)    /* 100 ms =  6 250 */

/* Timer2: 24-bit counter (TnPR:TnILR) */
#define COUNTER_24          0x00FFFFFFu
#define PERIOD_24          (COUNTER_24 + 1u)    /* 2^24 clock cycles */

/* ---------------------------------------------------------------------------------------------
 * Compare mode: one pin, controlled via TCACT and TnILR (see the comment at the top)
 * ------------------------------------------------------------------------------------------- */
typedef struct
{
    volatile uint32_t *mr;          /* GPTMTAMR of the timer  */
    volatile uint32_t *ilr;         /* GPTMTAILR of the timer */
    uint32_t period;               /* ticks of one period (after the prescaler) */
    volatile uint32_t high;         /* of which HIGH: 0 = always LOW, >= period = always HIGH */
    bool level;                     /* level of the phase that is running now */
} CompareChannel;

static CompareChannel pwm  = { &TIMER0_TAMR_R, &TIMER0_TAILR_R, DIM_PERIOD_US, 0u, false };
static CompareChannel pulse = { &TIMER1_TAMR_R, &TIMER1_TAILR_R, PULSE_PERIOD, PULSE_HIGH, false };

/* In the ISR (phase n+1 has just started): set level and duration of phase n+2 */
static void next_phase(CompareChannel *k)
{
    bool level;
    uint32_t duration;
    uint32_t high = k->high;

    if (high == 0u)                 /* 0 %: always LOW */
    {
        level = false;
        duration = k->period;
    }
    else if (high >= k->period)    /* 100 %: always HIGH */
    {
        level = true;
        duration = k->period;
    }
    else                            /* alternating HIGH and LOW */
    {
        level = !k->level;
        duration = level ? high : k->period - high;
    }
    /* TCACT may be changed while the timer is running (data sheet GPTMTnMR) */
    *k->mr = (*k->mr & ~TIMER_TAMR_TCACT_M) | (level ? TIMER_TAMR_TCACT_SETTO : TIMER_TAMR_TCACT_CLRTO);
    *k->ilr = duration - 1u;           /* counting down: TnILR+1 ticks */
    k->level = level;               /* runs from the next time-out */
}

void TIMER0A_Handler(void)
{
    TIMER0_ICR_R = TIMER_ICR_TATOCINT;
    next_phase(&pwm);
}

void TIMER1A_Handler(void)
{
    TIMER1_ICR_R = TIMER_ICR_TATOCINT;
    next_phase(&pulse);
}

/* ---------------------------------------------------------------------------------------------
 * Step (duty cycle of the PWM): key 0..3 -> 0, 25, 50, 100 %
 * ------------------------------------------------------------------------------------------- */
static const uint8_t PERCENT[4] = { 0u, 25u, 50u, 100u };
static volatile uint32_t duty_step;
static volatile bool duty_step_new;

static void set_duty_step(uint32_t s)
{
    pwm.high = DIM_PERIOD_US * PERCENT[s] / 100u;
    duty_step = s;
    duty_step_new = true;
    /* LED3 = bit 0, LED4 = bit 1 of the step */
    GPIO_PORTL_DATA_BITS_R[LED3 | LED4] = ((s & 1u) ? LED3 : 0u) | ((s & 2u) ? LED4 : 0u);
}

/* Key 1..3: GPIO interrupt on falling edge (press) */
void GPIOM_Handler(void)
{
    uint32_t edges = GPIO_PORTM_MIS_R & KEYS_GPIO;
    GPIO_PORTM_ICR_R = edges;
    if (edges & KEY3) set_duty_step(3u);
    else if (edges & KEY2) set_duty_step(2u);
    else if (edges & KEY1) set_duty_step(1u);
}

/* ---------------------------------------------------------------------------------------------
 * Timer2: duration of key 0 (capture)
 * ------------------------------------------------------------------------------------------- */
static volatile uint32_t overflows;   /* overflows of the 24-bit counter (Timer2B) */
static uint32_t press_start;           /* timestamp in clock cycles (modulo 2^32) */
static bool pressed;
static volatile uint32_t duration_ticks;
static volatile bool duration_new;

/* Timer2B: time-out every 2^24 clock cycles = overflow of Timer2A */
void TIMER2B_Handler(void)
{
    TIMER2_ICR_R = TIMER_ICR_TBTOCINT;
    overflows++;
}

/* Timestamp of an edge in clock cycles since start: overflows * 2^24 + elapsed clock cycles.
 * The overflow can happen shortly before or after the edge; that is why we check, with interrupts
 * disabled, whether the counter has overflowed since the edge and whether Timer2B is still pending. */
static uint32_t timestamp(uint32_t captured)
{
    uint32_t before, now, n;
    bool pending;

    __asm volatile("cpsid i");
    do
    {
        before = TIMER2_TAV_R & COUNTER_24;
        pending = (TIMER2_RIS_R & TIMER_RIS_TBTORIS) != 0;   /* overflow, ISR has not run yet */
        now = TIMER2_TAV_R & COUNTER_24;
    } while (now > before);                                /* overflowed in between: try again */
    n = overflows + (pending ? 1u : 0u);
    __asm volatile("cpsie i");

    if (now > captured) n--;       /* counting down: larger = overflowed since the edge */
    return n * PERIOD_24 + (COUNTER_24 - captured);
}

/* Timer2A: edge on key 0 (both edges) */
void TIMER2A_Handler(void)
{
    TIMER2_ICR_R = TIMER_ICR_CAECINT;
    uint32_t t = timestamp(TIMER2_TAR_R & COUNTER_24);

    if ((GPIO_PORTM_DATA_BITS_R[KEY0]) == 0u)   /* LOW = pressed: falling edge */
    {
        press_start = t;
        pressed = true;
        set_duty_step(0u);
    }
    else if (pressed)                           /* released: rising edge */
    {
        duration_ticks = t - press_start;
        pressed = false;
        duration_new = true;
    }
}

/* ---------------------------------------------------------------------------------------------
 * UART0: output (polling, only from the main program)
 * ------------------------------------------------------------------------------------------- */
static void uart_putc(char c)
{
    while (UART0_FR_R & UART_FR_TXFF) {}
    UART0_DR_R = (uint8_t)c;
}

static void uart_puts(const char *s)
{
    while (*s) uart_putc(*s++);
}

/* Number in decimal, at least 'digits' digits (with leading zeros) */
static void uart_number(uint32_t value, uint32_t digits)
{
    char buf[10];
    uint32_t n = 0;
    do
    {
        buf[n++] = (char)('0' + value % 10u);
        value /= 10u;
    } while (value != 0u || n < digits);
    while (n > 0u) uart_putc(buf[--n]);
}

/* ---------------------------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------------------------- */
static void config_clocks(void)
{
    SYSCTL_RCGCGPIO_R |= SYSCTL_RCGCGPIO_R0 | SYSCTL_RCGCGPIO_R10 | SYSCTL_RCGCGPIO_R11;  /* A, L, M */
    SYSCTL_RCGCTIMER_R |= SYSCTL_RCGCTIMER_R0 | SYSCTL_RCGCTIMER_R1 | SYSCTL_RCGCTIMER_R2;
    SYSCTL_RCGCUART_R |= SYSCTL_RCGCUART_R0;
    while ((SYSCTL_PRGPIO_R & (SYSCTL_PRGPIO_R0 | SYSCTL_PRGPIO_R10 | SYSCTL_PRGPIO_R11))
               != (SYSCTL_PRGPIO_R0 | SYSCTL_PRGPIO_R10 | SYSCTL_PRGPIO_R11)
           || (SYSCTL_PRTIMER_R & (SYSCTL_PRTIMER_R0 | SYSCTL_PRTIMER_R1 | SYSCTL_PRTIMER_R2))
               != (SYSCTL_PRTIMER_R0 | SYSCTL_PRTIMER_R1 | SYSCTL_PRTIMER_R2)
           || (SYSCTL_PRUART_R & SYSCTL_PRUART_R0) == 0u)
    {
    }
}

static void config_uart0(void)
{
    GPIO_PORTA_AHB_DEN_R |= PINS_UART0;
    GPIO_PORTA_AHB_AFSEL_R |= PINS_UART0;
    GPIO_PORTA_AHB_PCTL_R = (GPIO_PORTA_AHB_PCTL_R & ~(PCTL_MASK(0) | PCTL_MASK(1)))
                          | PCTL_FUNCTION(0, PCTL_UART0) | PCTL_FUNCTION(1, PCTL_UART0);
    UART0_CTL_R &= ~UART_CTL_UARTEN;
    UART0_IBRD_R = 8;                              /* 16 MHz / (16 * 115200) = 8.6806 */
    UART0_FBRD_R = 44;                             /* 0.6806 * 64 = 43.6 -> 44 */
    UART0_LCRH_R = UART_LCRH_WLEN_8 | UART_LCRH_FEN;   /* 8N1, FIFO */
    UART0_CTL_R |= UART_CTL_TXE | UART_CTL_RXE | UART_CTL_UARTEN;
}

static void config_pins(void)
{
    /* Port L: PL4/PL6 = CCP outputs of the timers, PL0/PL1 = GPIO outputs */
    GPIO_PORTL_DIR_R |= LED3 | LED4;
    GPIO_PORTL_AFSEL_R |= LED1 | LED2;
    GPIO_PORTL_PCTL_R = (GPIO_PORTL_PCTL_R & ~(PCTL_MASK(4) | PCTL_MASK(6)))
                      | PCTL_FUNCTION(4, PCTL_CCP) | PCTL_FUNCTION(6, PCTL_CCP);
    GPIO_PORTL_DEN_R |= LED1 | LED2 | LED3 | LED4;

    /* Port M: PM0 = T2CCP0 (input of the timer), PM1..PM3 = GPIO inputs; all with pull-up */
    GPIO_PORTM_DIR_R &= ~(KEY0 | KEYS_GPIO);
    GPIO_PORTM_PUR_R |= KEY0 | KEYS_GPIO;
    GPIO_PORTM_AFSEL_R |= KEY0;
    GPIO_PORTM_PCTL_R = (GPIO_PORTM_PCTL_R & ~PCTL_MASK(0)) | PCTL_FUNCTION(0, PCTL_CCP);
    GPIO_PORTM_DEN_R |= KEY0 | KEYS_GPIO;

    /* Key 1..3: interrupt on falling edge */
    GPIO_PORTM_IM_R &= ~KEYS_GPIO;
    GPIO_PORTM_IS_R &= ~KEYS_GPIO;
    GPIO_PORTM_IBE_R &= ~KEYS_GPIO;
    GPIO_PORTM_IEV_R &= ~KEYS_GPIO;
    GPIO_PORTM_ICR_R = KEYS_GPIO;
    GPIO_PORTM_IM_R |= KEYS_GPIO;
}

/* Start timer A of a timer in 16-bit compare mode: the first two phases are LOW */
static void config_compare(volatile uint32_t *ctl, volatile uint32_t *cfg, volatile uint32_t *pr,
                           volatile uint32_t *imr, CompareChannel *k, uint32_t prescaler)
{
    *ctl = 0u;                                     /* timer off before it is configured */
    *cfg = TIMER_CFG_16_BIT;
    *k->mr = TIMER_TAMR_TAMR_PERIOD                /* periodic, counting down (TACDIR = 0) */
           | TIMER_TAMR_TAILD                      /* new TAILR only at the next time-out */
           | TIMER_TAMR_TCACT_CLRTO;               /* end of phase 0: pin LOW */
    *pr = prescaler;
    *k->ilr = k->period - 1u;                     /* phase 0 (loaded when the timer is enabled) */
    *imr = TIMER_IMR_TATOIM;
    *ctl = TIMER_CTL_TAEN;
    *k->ilr = k->period - 1u;                     /* phase 1 (TAILD: valid from the 1st time-out) */
    k->level = false;                              /* phase 1 is LOW, the ISR schedules from phase 2 on */
}

static void config_capture(void)
{
    TIMER2_CTL_R = 0u;
    TIMER2_CFG_R = TIMER_CFG_16_BIT;
    TIMER2_TAMR_R = TIMER_TAMR_TAMR_CAP | TIMER_TAMR_TACMR;   /* edge-time, counting down */
    TIMER2_TBMR_R = TIMER_TBMR_TBMR_PERIOD;                   /* overflow counter, counting down */
    TIMER2_TAPR_R = 0xFFu;                                    /* 24 Bit: 0xFF:FFFF */
    TIMER2_TAILR_R = 0xFFFFu;
    TIMER2_TBPR_R = 0xFFu;                                    /* (0xFF+1) * (0xFFFF+1) = 2^24 */
    TIMER2_TBILR_R = 0xFFFFu;
    TIMER2_ICR_R = TIMER_ICR_CAECINT | TIMER_ICR_TBTOCINT;
    TIMER2_IMR_R = TIMER_IMR_CAEIM | TIMER_IMR_TBTOIM;
    /* start both halves with one write access: same clock cycle, same overflows */
    TIMER2_CTL_R = TIMER_CTL_TAEVENT_BOTH | TIMER_CTL_TAEN | TIMER_CTL_TBEN;
}

static void config_nvic(void)
{
    /* Priority (0 = highest, bits 7:5): Timer2B 0, Timer2A 1, all others 2 */
    NVIC_PRI4_R = (NVIC_PRI4_R & ~NVIC_PRI4_INT19_M) | (2u << NVIC_PRI4_INT19_S);
    NVIC_PRI5_R = (NVIC_PRI5_R & ~(NVIC_PRI5_INT21_M | NVIC_PRI5_INT23_M))
                | (2u << NVIC_PRI5_INT21_S) | (1u << NVIC_PRI5_INT23_S);
    NVIC_PRI6_R = (NVIC_PRI6_R & ~NVIC_PRI6_INT24_M) | (0u << NVIC_PRI6_INT24_S);
    NVIC_PRI18_R = (NVIC_PRI18_R & ~NVIC_PRI18_INTA_M) | (2u << NVIC_PRI18_INTA_S);   /* INTA = IRQ 72 */
    NVIC_EN0_R = (1u << IRQ_TIMER0A) | (1u << IRQ_TIMER1A) | (1u << IRQ_TIMER2A) | (1u << IRQ_TIMER2B);
    NVIC_EN2_R = 1u << (IRQ_GPIOM - 64u);
}

int main(void)
{
    config_clocks();
    config_uart0();
    config_pins();
    set_duty_step(1u);                              /* start with 25 % */
    config_nvic();
    config_compare(&TIMER0_CTL_R, &TIMER0_CFG_R, &TIMER0_TAPR_R, &TIMER0_IMR_R, &pwm, DIM_PRESCALER);
    config_compare(&TIMER1_CTL_R, &TIMER1_CFG_R, &TIMER1_TAPR_R, &TIMER1_IMR_R, &pulse, PULSE_PRESCALER);
    config_capture();
    __asm volatile("cpsie i");

    uart_puts("\r\nExample 05 Timer CCP: LED1 = PWM 30 Hz (Timer0), LED2 = pulse 100 ms/1 s (Timer1)\r\n");
    uart_puts("Key 0..3 = 0/25/50/100 %, Timer2 measures how long key 0 is pressed\r\n");

    while (1)
    {
        __asm volatile("wfi");                     /* sleep until the next interrupt */
        if (duty_step_new)
        {
            duty_step_new = false;
            uart_puts("PWM: ");
            uart_number(PERCENT[duty_step], 1u);
            uart_puts(" %\r\n");
        }
        if (duration_new)
        {
            duration_new = false;
            uint32_t us = duration_ticks / TICKS_PER_US;
            uart_puts("Key 0 pressed: ");
            uart_number(us / 1000u, 1u);
            uart_putc('.');
            uart_number(us % 1000u, 3u);
            uart_puts(" ms\r\n");
        }
    }
}
