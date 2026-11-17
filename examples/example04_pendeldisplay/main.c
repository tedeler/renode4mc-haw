/*
 * Example 04 - Pendulum display: show the distance from the ultrasonic sensor on a POV pendulum
 * Board: EK-TM4C1294XL (TM4C1294NCPDT), clock: 16 MHz (clock after reset, not changed here)
 *
 * Runs in the simulator (web console, experiment "example2") and on the board with extra hardware.
 *
 *   Component                Connection                         Use in the program
 *   ------------------------ ---------------------------------- -------------------------------------
 *   Pendulum display, 8 LEDs PM0..PM7 (outputs),                one image column = one byte on port M
 *                            pivot at the bottom, PM0 = LED at
 *                            the tip (top), PM7 = bottom LED
 *   Pendulum signal          PL0 (input)                         HIGH = pendulum right, LOW = left;
 *                                                                interrupt on both edges
 *   UART0 (Virtual COM)      PA0 = RX, PA1 = TX, 115200 8N1      messages (distance, pendulum period)
 *   I2C0                     PB2 = SCL, PB3 = SDA, 100 kHz       ultrasonic sensor MB1242 (0x70)
 *   LED D2                   PN0 (output)                        heartbeat 1 Hz
 *   Timer0A                  -                                   100 ms tick (sensor, heartbeat)
 *   Timer1A                  -                                   one-shot timer: time of the next image column
 *   Timer2A                  -                                   free-running, measures the pendulum period
 *
 * Principle (POV = persistence of vision):
 *   The pendulum swings 10 times per second (period T = 100 ms; adjustable in the web console,
 *   the firmware keeps measuring T and accepts 0.1..50 Hz). If the firmware changes the LEDs
 *   exactly when the pendulum is at the right position, the eye sees a stationary image
 *   of 40 columns with 8 dots each. The reference point is the zero crossing (edge on PL0):
 *   half a period after each edge the pendulum passes the centre again, this time in the
 *   other direction. Around this point in time one line of the image is "written".
 *
 * Register names and bit constants: TI header file tm4c1294ncpdt.h (common/), no addresses of
 * our own. Look them up in the data sheet "TM4C1294NCPDT" (SPMS433).
 */
#include <stdint.h>
#include <stdbool.h>
#include "tm4c1294ncpdt.h"

#define SYSTEM_CLOCK_HZ     16000000u

/* ---------------------------------------------------------------------------------------------
 * Registers: all names (..._R) and bit constants come from tm4c1294ncpdt.h.
 * Only constants that the header file does not know are defined here (pins, pin functions, IRQs).
 * ------------------------------------------------------------------------------------------- */
/* Bits of the modules used, in RCGC... and PR... */
#define PORTS_CLOCK          (SYSCTL_RCGCGPIO_R0 | SYSCTL_RCGCGPIO_R1 | SYSCTL_RCGCGPIO_R10 | \
                             SYSCTL_RCGCGPIO_R11 | SYSCTL_RCGCGPIO_R12)            /* A, B, L, M, N */
#define PORTS_READY        (SYSCTL_PRGPIO_R0 | SYSCTL_PRGPIO_R1 | SYSCTL_PRGPIO_R10 | \
                             SYSCTL_PRGPIO_R11 | SYSCTL_PRGPIO_R12)
#define TIMERS_CLOCK          (SYSCTL_RCGCTIMER_R0 | SYSCTL_RCGCTIMER_R1 | SYSCTL_RCGCTIMER_R2)
#define TIMERS_READY        (SYSCTL_PRTIMER_R0 | SYSCTL_PRTIMER_R1 | SYSCTL_PRTIMER_R2)

/* GPIOPCTL: 4 bits per pin select the alternate function (data sheet, table
 * "GPIO Pins and Alternate Functions"). The header file has no constants for this. */
#define PCTL_MASK(pin)     (0xFu << (4u * (pin)))
#define PCTL_FUNCTION(pin, f) ((uint32_t)(f) << (4u * (pin)))
#define PCTL_UART0          1u                 /* PA0 = U0RX, PA1 = U0TX */
#define PCTL_I2C0           2u                 /* PB2 = I2C0SCL, PB3 = I2C0SDA */

/* NVIC: INT_... from the header file is the number in the vector table; the NVIC counts
 * from the first peripheral interrupt (entry 16). EN0 = IRQ 0..31, EN1 = IRQ 32..63. */
#define IRQ_TIMER0A         (INT_TIMER0A - 16u)   /* 19 */
#define IRQ_TIMER1A         (INT_TIMER1A - 16u)   /* 21 */
#define IRQ_GPIOL           (INT_GPIOL - 16u)     /* 53 */

/* Pins */
#define LED_D2              (1u << 0)          /* PN0 */
#define PENDULUM_SYNC         (1u << 0)          /* PL0 */
#define PENDULUM_LEDS         0xFFu              /* PM0..PM7 */
#define PINS_UART0          0x03u              /* PA0 = U0RX, PA1 = U0TX */
#define PINS_I2C0           0x0Cu              /* PB2 = I2C0SCL, PB3 = I2C0SDA */
#define PIN_I2C0_SDA        0x08u              /* PB3 */

/* Device address on the I2C bus (7 bit) */
#define SONAR_ADDR          0x70u

/* ---------------------------------------------------------------------------------------------
 * Pendulum display: image and schedule
 *
 * The image has COLUMNS columns. Column k lies between the deflections x(k) and x(k+1) with
 *     x(k) = -0.9 + 1.8 * k / COLUMNS        (x = -1: far left, x = +1: far right)
 * The outer 10 % of the swing range stay empty: there the pendulum is very slow and the
 * columns would become too wide.
 *
 * The pendulum does not move at constant speed but like x(t) = sin(2*pi*t/T). So column k
 * starts at the time  t(k) = asin(x(k)) / (2*pi) * T  (measured from the zero crossing).
 * The table contains t(k)/T in units of 1/65536 of the period, computed with
 *     python3 -c "import math; print([round(math.asin(-0.9+1.8*k/40)/(2*math.pi)*65536) for k in range(41)])"
 * It is valid for both swing directions: for the swing from right to left only the
 * order of the columns is reversed.
 * ------------------------------------------------------------------------------------------- */
#define COLUMNS             40u

static const int16_t columnTime_q16[COLUMNS + 1] = {
    -11680, -10697,  -9848,  -9085,  -8384,  -7729,  -7109,  -6518,  -5950,  -5401,
     -4869,  -4349,  -3841,  -3342,  -2852,  -2367,  -1888,  -1412,   -940,   -470,
         0,    470,    940,   1412,   1888,   2367,   2852,   3342,   3841,   4349,
      4869,   5401,   5950,   6518,   7109,   7729,   8384,   9085,   9848,  10697,
     11680,
};

#define PERIOD_NOMINAL        (SYSTEM_CLOCK_HZ / 10u)        /* 10 Hz: 100 ms = 1 600 000 clock cycles */
#define PERIOD_MIN         (SYSTEM_CLOCK_HZ / 50u)        /* fastest pendulum: 50 Hz */
#define PERIOD_MAX         (SYSTEM_CLOCK_HZ * 10u)        /* slowest pendulum: 0.1 Hz (10 s) */

static volatile uint8_t  image[COLUMNS];                    /* bit n = LED n (PMn), bit 0 at the top */
static volatile uint32_t period = PERIOD_NOMINAL;           /* measured pendulum period in clock cycles */
static int32_t           columnTicks[COLUMNS + 1];        /* t(k) in clock cycles, computed from period */

/* State of the image output (only used in the interrupt routines) */
static uint32_t column;                                    /* next column 0..COLUMNS */
static bool     toLeft;                                 /* true: swing from right to left */
static bool     running;                                    /* Timer1A is scheduled for a swing */
static uint32_t lastEdge;                               /* Timer2 value at the last edge */
static uint32_t center;                                     /* Timer2 value at the next zero crossing */

static void compute_schedule(uint32_t ticksPerPeriod)
{
    for (uint32_t k = 0; k <= COLUMNS; k++)
    {
        columnTicks[k] = (int32_t)(((int64_t)columnTime_q16[k] * (int64_t)ticksPerPeriod) / 65536);
    }
}

/*
 * Sets the one-shot timer (Timer1A) to the start of column k.
 * The point in time is computed ABSOLUTELY on the time base Timer2 (centre + t(k)) and not
 * relative to the previous column: otherwise the delay of every interrupt routine would add up
 * over all 40 columns, and the image would shift (in opposite directions on the two swings).
 * Timer2 counts DOWN: "later" means "smaller counter value".
 */
static void set_column_timer(uint32_t k)
{
    uint32_t dest = center - (uint32_t)columnTicks[k];
    int32_t wait = (int32_t)(TIMER2_TAV_R - dest);
    if (wait < 16)
    {
        wait = 16;                                       /* already passed: continue immediately */
    }
    TIMER1_TAILR_R = (uint32_t)wait - 1u;
    TIMER1_CTL_R |= TIMER_CTL_TAEN;
}

/* Statistics for the UART output */
static volatile uint32_t newPeriod;                      /* != 0: newly measured period */

/* ---------------------------------------------------------------------------------------------
 * Interrupt routines
 * ------------------------------------------------------------------------------------------- */
static volatile uint32_t ticks;            /* 100 ms counter (Timer0A) */

void TIMER0A_Handler(void)
{
    TIMER0_ICR_R = TIMER_ICR_TATOCINT;
    ticks++;
}

/*
 * Schedules the next swing through the centre.
 *   pendulum right (PL0 HIGH): the next pass goes to the LEFT
 *   pendulum left  (PL0 LOW):  the next pass goes to the RIGHT
 * This pass is half a period after the last edge; the first column starts
 * t(0) clock cycles earlier (t(0) is negative). So the edge itself lies IN THE MIDDLE of a swing -
 * that is why the next swing is only scheduled when the previous one is finished.
 */
static void plan_swing(void)
{
    center = lastEdge - period / 2u;                    /* half a period after the edge */
    int32_t untilStart = (int32_t)(TIMER2_TAV_R - (center - (uint32_t)columnTicks[0]));
    if (untilStart < 100)
    {
        running = false;                                    /* too late: wait for the next edge */
        return;
    }
    toLeft = (GPIO_PORTL_DATA_BITS_R[PENDULUM_SYNC] & PENDULUM_SYNC) != 0;
    column = 0;
    running = true;
    set_column_timer(0);
}

/* Edge on the pendulum signal (PL0) = pendulum passes the centre */
void GPIOL_Handler(void)
{
    static bool measured;                                  /* an edge has been seen already */
    static bool reported;                                  /* period already reported via UART */

    uint32_t now = TIMER2_TAV_R;               /* Timer2 counts down */
    GPIO_PORTL_ICR_R = PENDULUM_SYNC;

    /*
     * Period = 2 x time between two consecutive edges (half an oscillation).
     * This locks in twice as fast as measuring from rising edge to rising edge -
     * important for slow pendulums (0.1 Hz: 10 s per oscillation).
     */
    uint32_t t = 2u * (lastEdge - now);               /* down counter: old - new */
    if (measured && t >= PERIOD_MIN && t <= PERIOD_MAX)  /* ignore glitches */
    {
        uint32_t deviation = (t > period) ? t - period : period - t;
        if (deviation > period / 1000u)                  /* changed by more than 0.1 % */
        {
            period = t;
            compute_schedule(t);                         /* adapt the schedule to the real period */
            reported = false;
        }
        if (!reported)
        {
            newPeriod = t;
            reported = true;
        }
    }
    measured = true;

    lastEdge = now;
    if (!running)
    {
        plan_swing();                                  /* start, or after an interruption */
    }
}

/* One-shot timer: the next column starts now */
void TIMER1A_Handler(void)
{
    TIMER1_ICR_R = TIMER_ICR_TATOCINT;

    if (column >= COLUMNS)
    {
        GPIO_PORTM_DATA_R = 0;                         /* end of the image: LEDs off ... */
        plan_swing();                                  /* ... and schedule the next swing */
        return;
    }
    uint32_t index = toLeft ? (COLUMNS - 1u - column) : column;
    GPIO_PORTM_DATA_R = image[index];
    column++;
    set_column_timer(column);
}

/* ---------------------------------------------------------------------------------------------
 * UART0: 115200 baud at 16 MHz -> IBRD = 8, FBRD = 44 (see Example 03)
 * ------------------------------------------------------------------------------------------- */
#define BAUD_IBRD           8u
#define BAUD_FBRD           44u

static void uart_init(void)
{
    GPIO_PORTA_AHB_AFSEL_R |= PINS_UART0;
    GPIO_PORTA_AHB_PCTL_R = (GPIO_PORTA_AHB_PCTL_R & ~(PCTL_MASK(0) | PCTL_MASK(1)))
                          | PCTL_FUNCTION(0, PCTL_UART0) | PCTL_FUNCTION(1, PCTL_UART0);
    GPIO_PORTA_AHB_DEN_R |= PINS_UART0;

    UART0_CTL_R = 0;
    UART0_CC_R = UART_CC_CS_SYSCLK;
    UART0_IBRD_R = BAUD_IBRD;
    UART0_FBRD_R = BAUD_FBRD;
    UART0_LCRH_R = UART_LCRH_WLEN_8 | UART_LCRH_FEN;
    UART0_CTL_R = UART_CTL_UARTEN | UART_CTL_TXE | UART_CTL_RXE;
}

static void uart_putc(char c)
{
    while (UART0_FR_R & UART_FR_TXFF)
    {
    }
    UART0_DR_R = (uint8_t)c;
}

static void uart_puts(const char *s)
{
    while (*s)
    {
        if (*s == '\n')
        {
            uart_putc('\r');
        }
        uart_putc(*s++);
    }
}

/* Number as decimal text without leading spaces; returns the number of characters */
static int utoa(uint32_t value, char *dest)
{
    char tmp[11];
    int n = 0;
    do
    {
        tmp[n++] = (char)('0' + value % 10u);
        value /= 10u;
    } while (value != 0u);
    for (int i = 0; i < n; i++)
    {
        dest[i] = tmp[n - 1 - i];
    }
    dest[n] = '\0';
    return n;
}

/* ---------------------------------------------------------------------------------------------
 * I2C0 as master, 100 kHz (see Example 03)
 * ------------------------------------------------------------------------------------------- */
#define TPR_100KHZ          7u

static void i2c_init(void)
{
    GPIO_PORTB_AHB_AFSEL_R |= PINS_I2C0;
    GPIO_PORTB_AHB_ODR_R |= PIN_I2C0_SDA;
    GPIO_PORTB_AHB_PCTL_R = (GPIO_PORTB_AHB_PCTL_R & ~(PCTL_MASK(2) | PCTL_MASK(3)))
                          | PCTL_FUNCTION(2, PCTL_I2C0) | PCTL_FUNCTION(3, PCTL_I2C0);
    GPIO_PORTB_AHB_DEN_R |= PINS_I2C0;

    I2C0_MCR_R = I2C_MCR_MFE;
    I2C0_MTPR_R = TPR_100KHZ;
}

static bool i2c_wait(void)
{
    while (I2C0_MCS_R & I2C_MCS_BUSY)
    {
    }
    return (I2C0_MCS_R & I2C_MCS_ERROR) == 0;
}

static bool i2c_write(uint8_t addr, const uint8_t *data, uint32_t n)
{
    I2C0_MSA_R = (uint32_t)addr << I2C_MSA_SA_S;
    for (uint32_t i = 0; i < n; i++)
    {
        I2C0_MDR_R = data[i];
        uint32_t cmd = I2C_MCS_RUN;
        if (i == 0)     cmd |= I2C_MCS_START;
        if (i == n - 1) cmd |= I2C_MCS_STOP;
        I2C0_MCS_R = cmd;
        if (!i2c_wait())
        {
            I2C0_MCS_R = I2C_MCS_STOP;
            return false;
        }
    }
    return true;
}

static bool i2c_read(uint8_t addr, uint8_t *data, uint32_t n)
{
    I2C0_MSA_R = ((uint32_t)addr << I2C_MSA_SA_S) | I2C_MSA_RS;
    for (uint32_t i = 0; i < n; i++)
    {
        uint32_t cmd = I2C_MCS_RUN;
        if (i == 0)     cmd |= I2C_MCS_START;
        if (i < n - 1)  cmd |= I2C_MCS_ACK;
        else            cmd |= I2C_MCS_STOP;
        I2C0_MCS_R = cmd;
        if (!i2c_wait())
        {
            I2C0_MCS_R = I2C_MCS_STOP;
            return false;
        }
        data[i] = (uint8_t)(I2C0_MDR_R & I2C_MDR_DATA_M);
    }
    return true;
}

/* Ultrasonic sensor MB1242: writing 0x51 starts a measurement, then read 2 bytes (cm) */
static bool sonar_start(void)
{
    const uint8_t cmd = 0x51;
    return i2c_write(SONAR_ADDR, &cmd, 1);
}

static bool sonar_read(uint32_t *cm)
{
    uint8_t d[2];
    if (!i2c_read(SONAR_ADDR, d, 2))
    {
        return false;
    }
    *cm = ((uint32_t)d[0] << 8) | d[1];
    return true;
}

/* ---------------------------------------------------------------------------------------------
 * Text -> image. 5x7 font (columns, bit 0 = top = LED at the tip of the pendulum)
 * ------------------------------------------------------------------------------------------- */
static const uint8_t font5x7[][5] = {
    { 0x3E, 0x51, 0x49, 0x45, 0x3E },   /* 0 */
    { 0x00, 0x42, 0x7F, 0x40, 0x00 },   /* 1 */
    { 0x42, 0x61, 0x51, 0x49, 0x46 },   /* 2 */
    { 0x21, 0x41, 0x45, 0x4B, 0x31 },   /* 3 */
    { 0x18, 0x14, 0x12, 0x7F, 0x10 },   /* 4 */
    { 0x27, 0x45, 0x45, 0x45, 0x39 },   /* 5 */
    { 0x3C, 0x4A, 0x49, 0x49, 0x30 },   /* 6 */
    { 0x01, 0x71, 0x09, 0x05, 0x03 },   /* 7 */
    { 0x36, 0x49, 0x49, 0x49, 0x36 },   /* 8 */
    { 0x06, 0x49, 0x49, 0x29, 0x1E },   /* 9 */
    { 0x3E, 0x41, 0x41, 0x41, 0x22 },   /* C (index 10) */
    { 0x7F, 0x02, 0x0C, 0x02, 0x7F },   /* M (index 11) */
    { 0x08, 0x08, 0x08, 0x08, 0x08 },   /* - (index 12) */
    { 0x00, 0x00, 0x00, 0x00, 0x00 },   /* space (index 13) */
};

static uint32_t char_index(char c)
{
    if (c >= '0' && c <= '9') return (uint32_t)(c - '0');
    if (c == 'C') return 10u;
    if (c == 'M') return 11u;
    if (c == '-') return 12u;
    return 13u;
}

/* Writes the text centred into the image (6 columns per character, max. 6 characters) */
static void image_text(const char *text)
{
    uint8_t next[COLUMNS] = { 0 };
    uint32_t n = 0;
    while (text[n] && n < COLUMNS / 6u)
    {
        n++;
    }
    uint32_t x = (COLUMNS - (n * 6u - 1u)) / 2u;          /* pad on the left = centre */
    for (uint32_t i = 0; i < n; i++)
    {
        const uint8_t *z = font5x7[char_index(text[i])];
        for (uint32_t s = 0; s < 5u; s++)
        {
            next[x++] = z[s];
        }
        x++;                                               /* gap between characters */
    }
    for (uint32_t k = 0; k < COLUMNS; k++)
    {
        image[k] = next[k];
    }
}

/* ---------------------------------------------------------------------------------------------
 * Main program
 * ------------------------------------------------------------------------------------------- */
int main(void)
{
    SYSCTL_RCGCGPIO_R |= PORTS_CLOCK;
    SYSCTL_RCGCUART_R |= SYSCTL_RCGCUART_R0;
    SYSCTL_RCGCI2C_R |= SYSCTL_RCGCI2C_R0;
    SYSCTL_RCGCTIMER_R |= TIMERS_CLOCK;
    while ((SYSCTL_PRGPIO_R & PORTS_READY) != PORTS_READY || (SYSCTL_PRUART_R & SYSCTL_PRUART_R0) == 0 ||
           (SYSCTL_PRI2C_R & SYSCTL_PRI2C_R0) == 0 || (SYSCTL_PRTIMER_R & TIMERS_READY) != TIMERS_READY)
    {
    }

    /* LED D2 (heartbeat) */
    GPIO_PORTN_DIR_R |= LED_D2;
    GPIO_PORTN_DEN_R |= LED_D2;

    /* Pendulum LEDs: the whole port M as output */
    GPIO_PORTM_DIR_R |= PENDULUM_LEDS;
    GPIO_PORTM_DEN_R |= PENDULUM_LEDS;
    GPIO_PORTM_DATA_R = 0;

    /* Pendulum signal PL0: input, interrupt on both edges */
    GPIO_PORTL_DIR_R &= ~PENDULUM_SYNC;
    GPIO_PORTL_DEN_R |= PENDULUM_SYNC;
    GPIO_PORTL_IS_R &= ~PENDULUM_SYNC;                  /* edge */
    GPIO_PORTL_IBE_R |= PENDULUM_SYNC;                  /* both edges */
    GPIO_PORTL_ICR_R = PENDULUM_SYNC;
    GPIO_PORTL_IM_R |= PENDULUM_SYNC;

    uart_init();
    i2c_init();

    /* Timer0A: 100 ms periodic (sensor, heartbeat) */
    TIMER0_CTL_R = 0;
    TIMER0_CFG_R = TIMER_CFG_32_BIT_TIMER;
    TIMER0_TAMR_R = TIMER_TAMR_TAMR_PERIOD;
    TIMER0_TAILR_R = SYSTEM_CLOCK_HZ / 10u - 1u;
    TIMER0_ICR_R = TIMER_ICR_TATOCINT;
    TIMER0_IMR_R |= TIMER_IMR_TATOIM;

    /* Timer1A: one-shot timer for the columns (started in the ISRs) */
    TIMER1_CTL_R = 0;
    TIMER1_CFG_R = TIMER_CFG_32_BIT_TIMER;
    TIMER1_TAMR_R = TIMER_TAMR_TAMR_1_SHOT;
    TIMER1_ICR_R = TIMER_ICR_TATOCINT;
    TIMER1_IMR_R |= TIMER_IMR_TATOIM;

    /* Timer2A: free-running (32 bit, periodic, no interrupt) as time base */
    TIMER2_CTL_R = 0;
    TIMER2_CFG_R = TIMER_CFG_32_BIT_TIMER;
    TIMER2_TAMR_R = TIMER_TAMR_TAMR_PERIOD;
    TIMER2_TAILR_R = TIMER_TAILR_M;               /* largest start value: runs ~268 s */
    TIMER2_CTL_R |= TIMER_CTL_TAEN;

    compute_schedule(period);
    image_text("---");

    NVIC_EN0_R = (1u << IRQ_TIMER0A) | (1u << IRQ_TIMER1A);
    NVIC_EN1_R = 1u << (IRQ_GPIOL - 32u);
    __asm volatile("cpsie i");
    TIMER0_CTL_R |= TIMER_CTL_TAEN;

    uart_puts("\nrenode4mc-haw - Example 04 Pendulum display\n");
    uart_puts("Set the distance at the sensor; it appears on the pendulum and here.\n");

    uint32_t lastTick = 0;
    uint32_t distance = UINT32_MAX;              /* no measurement yet */
    char text[16];

    while (1)
    {
        if (ticks != lastTick)
        {
            lastTick = ticks;

            if (lastTick % 5u == 0u)
            {
                GPIO_PORTN_DATA_BITS_R[LED_D2] ^= LED_D2;            /* D2: 1 Hz */
            }

            if (lastTick % 2u == 0u)
            {
                sonar_start();                                    /* start a measurement ... */
            }
            else
            {
                uint32_t cm;
                if (sonar_read(&cm) && cm != distance)             /* ... read it 100 ms later */
                {
                    distance = cm;
                    int n = utoa(cm, text);
                    text[n] = 'C';
                    text[n + 1] = 'M';
                    text[n + 2] = '\0';
                    image_text(text);

                    uart_puts("Distance: ");
                    text[n] = '\0';
                    uart_puts(text);
                    uart_puts(" cm\n");
                }
            }
        }

        if (newPeriod)
        {
            uint32_t p = newPeriod;
            newPeriod = 0;
            const uint32_t ticksPer100us = SYSTEM_CLOCK_HZ / 10000u;
            int n = utoa((p + ticksPer100us / 2u) / ticksPer100us, text); /* in 0.1 ms, rounded */
            uart_puts("Pendulum period: ");
            for (int i = 0; i < n - 1; i++) uart_putc(text[i]);
            uart_putc('.');
            uart_putc(text[n - 1]);
            uart_puts(" ms\n");
        }

        __asm volatile("wfi");                            /* sleep until the next interrupt */
    }
}
