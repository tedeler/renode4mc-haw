/*
 * Example 03 - Web console: demo for all controls of Example 1 (direct register access)
 * Board: EK-TM4C1294XL (TM4C1294NCPDT), clock: 16 MHz (clock after reset, not changed here)
 *
 * Runs in the simulator (web console, experiment "example1") and on the board with extra hardware.
 *
 *   Component                Connection                         Use in the program
 *   ------------------------ ---------------------------------- -------------------------------------
 *   LEDs D1, D2, D3, D4      PN1, PN0, PF4, PF0 (outputs)        D1 = distance < 50 cm, D2 = heartbeat,
 *                                                                D3/D4 = toggled by USR_SW1/USR_SW2
 *   Buttons USR_SW1, SW2     PJ0, PJ1 (inputs, pull-up,          interrupt on falling edge (press)
 *                            pressed = LOW)
 *   UART0 (Virtual COM)      PA0 = RX, PA1 = TX, 115200 8N1      messages, echo of received characters
 *   I2C0                     PB2 = SCL, PB3 = SDA, 100 kHz       OLED (0x3C) and ultrasonic sensor (0x70)
 *   OLED SSD1306 128x64      I2C0, address 0x3C                  text display (distance, key, ...)
 *   Ultrasonic MB1242        I2C0, address 0x70                  measurement every 200 ms
 *   Keypad 4x3               rows PK0..PK3 (outputs),            interrupt on the columns, then row scan
 *                            columns PK4..PK6 (inputs, pull-down)
 *   Timer0A                  -                                   100 ms tick (interrupt)
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
/* Bits of the ports used, in RCGCGPIO and PRGPIO (A = bit 0 ... N = bit 12) */
#define PORTS_CLOCK          (SYSCTL_RCGCGPIO_R0 | SYSCTL_RCGCGPIO_R1 | SYSCTL_RCGCGPIO_R5 | \
                             SYSCTL_RCGCGPIO_R8 | SYSCTL_RCGCGPIO_R9 | SYSCTL_RCGCGPIO_R12)
#define PORTS_READY        (SYSCTL_PRGPIO_R0 | SYSCTL_PRGPIO_R1 | SYSCTL_PRGPIO_R5 | \
                             SYSCTL_PRGPIO_R8 | SYSCTL_PRGPIO_R9 | SYSCTL_PRGPIO_R12)

/* GPIOPCTL: 4 bits per pin select the alternate function (data sheet, table
 * "GPIO Pins and Alternate Functions"). The header file has no constants for this. */
#define PCTL_MASK(pin)     (0xFu << (4u * (pin)))
#define PCTL_FUNCTION(pin, f) ((uint32_t)(f) << (4u * (pin)))
#define PCTL_UART0          1u                 /* PA0 = U0RX, PA1 = U0TX */
#define PCTL_I2C0           2u                 /* PB2 = I2C0SCL, PB3 = I2C0SDA */

/* NVIC: INT_... from the header file is the number in the vector table; the NVIC counts
 * from the first peripheral interrupt (entry 16). EN0 = IRQ 0..31, EN1 = IRQ 32..63. */
#define IRQ_TIMER0A         (INT_TIMER0A - 16u)   /* 19 */
#define IRQ_GPIOJ           (INT_GPIOJ - 16u)     /* 51 */
#define IRQ_GPIOK           (INT_GPIOK - 16u)     /* 52 */

/* Pins */
#define LED_D1              (1u << 1)          /* PN1 */
#define LED_D2              (1u << 0)          /* PN0 */
#define LED_D3              (1u << 4)          /* PF4 */
#define LED_D4              (1u << 0)          /* PF0 */
#define SW1                 (1u << 0)          /* PJ0 */
#define SW2                 (1u << 1)          /* PJ1 */
#define KP_ROWS             0x0Fu              /* PK0..PK3 */
#define KP_COLS             0x70u              /* PK4..PK6 */
#define KP_COL_SHIFT        4u
#define PINS_UART0          0x03u              /* PA0 = U0RX, PA1 = U0TX */
#define PINS_I2C0           0x0Cu              /* PB2 = I2C0SCL, PB3 = I2C0SDA */
#define PIN_I2C0_SDA        0x08u              /* PB3 */

/* Device addresses on the I2C bus (7 bit) */
#define OLED_ADDR           0x3Cu
#define SONAR_ADDR          0x70u

/* ---------------------------------------------------------------------------------------------
 * Events from the interrupt routines (volatile: used both in the ISR and in main)
 * ------------------------------------------------------------------------------------------- */
static volatile uint32_t ticks;            /* 100 ms counter (Timer0A) */
static volatile bool     keypadEvent;      /* edge on a keypad column */
static volatile uint32_t buttonEvents;     /* bit 0 = SW1 pressed, bit 1 = SW2 pressed */

void TIMER0A_Handler(void)
{
    TIMER0_ICR_R = TIMER_ICR_TATOCINT;
    ticks++;
}

void GPIOJ_Handler(void)
{
    uint32_t mis = GPIO_PORTJ_AHB_MIS_R;
    GPIO_PORTJ_AHB_ICR_R = mis;
    buttonEvents |= mis & (SW1 | SW2);
}

void GPIOK_Handler(void)
{
    GPIO_PORTK_ICR_R = GPIO_PORTK_MIS_R;
    keypadEvent = true;
}

/* ---------------------------------------------------------------------------------------------
 * UART0: 115200 baud at 16 MHz -> BRD = 16e6 / (16 * 115200) = 8.6806
 *        IBRD = 8, FBRD = round(0.6806 * 64) = 44
 * ------------------------------------------------------------------------------------------- */
#define BAUD_IBRD           8u
#define BAUD_FBRD           44u

static void uart_init(void)
{
    GPIO_PORTA_AHB_AFSEL_R |= PINS_UART0;                  /* PA0, PA1: alternate function ... */
    GPIO_PORTA_AHB_PCTL_R = (GPIO_PORTA_AHB_PCTL_R & ~(PCTL_MASK(0) | PCTL_MASK(1)))
                          | PCTL_FUNCTION(0, PCTL_UART0) | PCTL_FUNCTION(1, PCTL_UART0); /* U0RX/U0TX */
    GPIO_PORTA_AHB_DEN_R |= PINS_UART0;

    UART0_CTL_R = 0;                                        /* switch off for configuration */
    UART0_CC_R = UART_CC_CS_SYSCLK;                         /* clock = system clock */
    UART0_IBRD_R = BAUD_IBRD;
    UART0_FBRD_R = BAUD_FBRD;
    UART0_LCRH_R = UART_LCRH_WLEN_8 | UART_LCRH_FEN;        /* 8 data bits, FIFO on */
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

static bool uart_getc(char *c)
{
    if (UART0_FR_R & UART_FR_RXFE)
    {
        return false;
    }
    *c = (char)(UART0_DR_R & UART_DR_DATA_M);
    return true;
}

/* Number as decimal text (right-aligned in "width" characters, padded with spaces) */
static void utoa_pad(uint32_t value, char *dest, int width)
{
    char tmp[11];
    int n = 0;
    do
    {
        tmp[n++] = (char)('0' + value % 10u);
        value /= 10u;
    } while (value != 0u && n < 10);
    int i = 0;
    for (; i < width - n; i++)
    {
        dest[i] = ' ';
    }
    while (n > 0)
    {
        dest[i++] = tmp[--n];
    }
    dest[i] = '\0';
}

/* ---------------------------------------------------------------------------------------------
 * I2C0 as master, 100 kHz:  MTPR = SysClk / (2 * (6 + 4) * 100 kHz) - 1 = 7
 * ------------------------------------------------------------------------------------------- */
#define TPR_100KHZ          7u

static void i2c_init(void)
{
    GPIO_PORTB_AHB_AFSEL_R |= PINS_I2C0;                   /* PB2, PB3: alternate function */
    GPIO_PORTB_AHB_ODR_R |= PIN_I2C0_SDA;                      /* SDA (PB3) as open drain */
    GPIO_PORTB_AHB_PCTL_R = (GPIO_PORTB_AHB_PCTL_R & ~(PCTL_MASK(2) | PCTL_MASK(3)))
                          | PCTL_FUNCTION(2, PCTL_I2C0) | PCTL_FUNCTION(3, PCTL_I2C0); /* SCL/SDA */
    GPIO_PORTB_AHB_DEN_R |= PINS_I2C0;

    I2C0_MCR_R = I2C_MCR_MFE;                               /* master mode */
    I2C0_MTPR_R = TPR_100KHZ;
}

/* Waits for the end of a command; true = no error (the device acknowledged) */
static bool i2c_wait(void)
{
    while (I2C0_MCS_R & I2C_MCS_BUSY)
    {
    }
    return (I2C0_MCS_R & I2C_MCS_ERROR) == 0;
}

/* Writes n bytes to a device: START, data, STOP */
static bool i2c_write(uint8_t addr, const uint8_t *data, uint32_t n)
{
    I2C0_MSA_R = (uint32_t)addr << I2C_MSA_SA_S;            /* R/S = 0: write */
    for (uint32_t i = 0; i < n; i++)
    {
        I2C0_MDR_R = data[i];
        uint32_t cmd = I2C_MCS_RUN;
        if (i == 0)     cmd |= I2C_MCS_START;
        if (i == n - 1) cmd |= I2C_MCS_STOP;
        I2C0_MCS_R = cmd;
        if (!i2c_wait())
        {
            I2C0_MCS_R = I2C_MCS_STOP;                      /* error: release the bus */
            return false;
        }
    }
    return true;
}

/* Reads n (>= 2) bytes from a device: START, data with ACK, last byte without ACK + STOP */
static bool i2c_read(uint8_t addr, uint8_t *data, uint32_t n)
{
    I2C0_MSA_R = ((uint32_t)addr << I2C_MSA_SA_S) | I2C_MSA_RS; /* R/S = 1: read */
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

/* ---------------------------------------------------------------------------------------------
 * OLED SSD1306 (128 x 64, 8 "pages" of 8 pixel rows each)
 * Every I2C transfer starts with a control byte: 0x00 = commands follow, 0x40 = image data.
 * ------------------------------------------------------------------------------------------- */
static bool oled_ok;

static void oled_init(void)
{
    static const uint8_t init[] = {
        0x00,               /* control byte: commands */
        0xAE,               /* display off */
        0xD5, 0x80,         /* clock divider */
        0xA8, 0x3F,         /* multiplex 64 rows */
        0xD3, 0x00,         /* no offset */
        0x40,               /* start line 0 */
        0x8D, 0x14,         /* charge pump on */
        0x20, 0x02,         /* page addressing */
        0xA1, 0xC8,         /* mirroring (connector at the top) */
        0xDA, 0x12,         /* COM-Pins */
        0x81, 0x7F,         /* contrast */
        0xA4, 0xA6,         /* show RAM, not inverted */
        0xAF                /* display on */
    };
    oled_ok = i2c_write(OLED_ADDR, init, sizeof init);
}

/* 5x7 font (columns, bit 0 = top) for the characters used, ' '..'Z' */
static const uint8_t font5x7[][5] = {
    [' ' - ' '] = {0x00, 0x00, 0x00, 0x00, 0x00},
    ['#' - ' '] = {0x14, 0x7F, 0x14, 0x7F, 0x14},
    ['*' - ' '] = {0x14, 0x08, 0x3E, 0x08, 0x14},
    ['-' - ' '] = {0x08, 0x08, 0x08, 0x08, 0x08},
    ['.' - ' '] = {0x00, 0x60, 0x60, 0x00, 0x00},
    ['0' - ' '] = {0x3E, 0x51, 0x49, 0x45, 0x3E},
    ['1' - ' '] = {0x00, 0x42, 0x7F, 0x40, 0x00},
    ['2' - ' '] = {0x42, 0x61, 0x51, 0x49, 0x46},
    ['3' - ' '] = {0x21, 0x41, 0x45, 0x4B, 0x31},
    ['4' - ' '] = {0x18, 0x14, 0x12, 0x7F, 0x10},
    ['5' - ' '] = {0x27, 0x45, 0x45, 0x45, 0x39},
    ['6' - ' '] = {0x3C, 0x4A, 0x49, 0x49, 0x30},
    ['7' - ' '] = {0x01, 0x71, 0x09, 0x05, 0x03},
    ['8' - ' '] = {0x36, 0x49, 0x49, 0x49, 0x36},
    ['9' - ' '] = {0x06, 0x49, 0x49, 0x29, 0x1E},
    [':' - ' '] = {0x00, 0x36, 0x36, 0x00, 0x00},
    ['A' - ' '] = {0x7E, 0x11, 0x11, 0x11, 0x7E},
    ['B' - ' '] = {0x7F, 0x49, 0x49, 0x49, 0x36},
    ['C' - ' '] = {0x3E, 0x41, 0x41, 0x41, 0x22},
    ['D' - ' '] = {0x7F, 0x41, 0x41, 0x22, 0x1C},
    ['E' - ' '] = {0x7F, 0x49, 0x49, 0x49, 0x41},
    ['F' - ' '] = {0x7F, 0x09, 0x09, 0x09, 0x01},
    ['G' - ' '] = {0x3E, 0x41, 0x49, 0x49, 0x7A},
    ['H' - ' '] = {0x7F, 0x08, 0x08, 0x08, 0x7F},
    ['I' - ' '] = {0x00, 0x41, 0x7F, 0x41, 0x00},
    ['J' - ' '] = {0x20, 0x40, 0x41, 0x3F, 0x01},
    ['K' - ' '] = {0x7F, 0x08, 0x14, 0x22, 0x41},
    ['L' - ' '] = {0x7F, 0x40, 0x40, 0x40, 0x40},
    ['M' - ' '] = {0x7F, 0x02, 0x0C, 0x02, 0x7F},
    ['N' - ' '] = {0x7F, 0x04, 0x08, 0x10, 0x7F},
    ['O' - ' '] = {0x3E, 0x41, 0x41, 0x41, 0x3E},
    ['P' - ' '] = {0x7F, 0x09, 0x09, 0x09, 0x06},
    ['Q' - ' '] = {0x3E, 0x41, 0x51, 0x21, 0x5E},
    ['R' - ' '] = {0x7F, 0x09, 0x19, 0x29, 0x46},
    ['S' - ' '] = {0x46, 0x49, 0x49, 0x49, 0x31},
    ['T' - ' '] = {0x01, 0x01, 0x7F, 0x01, 0x01},
    ['U' - ' '] = {0x3F, 0x40, 0x40, 0x40, 0x3F},
    ['V' - ' '] = {0x1F, 0x20, 0x40, 0x20, 0x1F},
    ['W' - ' '] = {0x3F, 0x40, 0x38, 0x40, 0x3F},
    ['X' - ' '] = {0x63, 0x14, 0x08, 0x14, 0x63},
    ['Y' - ' '] = {0x07, 0x08, 0x70, 0x08, 0x07},
    ['Z' - ' '] = {0x61, 0x51, 0x49, 0x45, 0x43},
};

/* Writes a line of text (max. 21 characters) to page 0..7; the rest of the line is cleared. */
static void oled_text(uint8_t page, const char *text)
{
    if (!oled_ok)
    {
        return;
    }
    const uint8_t pos[] = { 0x00, (uint8_t)(0xB0u | page), 0x00, 0x10 }; /* page, column 0 */
    i2c_write(OLED_ADDR, pos, sizeof pos);

    uint8_t line[1 + 128];
    line[0] = 0x40;                                      /* control byte: image data */
    uint32_t x = 1;
    for (; *text && x + 6 <= sizeof line; text++)
    {
        char c = *text;
        if (c >= 'a' && c <= 'z')
        {
            c = (char)(c - 'a' + 'A');                    /* the font only has capital letters */
        }
        if (c < ' ' || c > 'Z')
        {
            c = ' ';
        }
        for (int i = 0; i < 5; i++)
        {
            line[x++] = font5x7[c - ' '][i];
        }
        line[x++] = 0x00;                                /* gap between characters */
    }
    while (x < sizeof line)
    {
        line[x++] = 0x00;
    }
    i2c_write(OLED_ADDR, line, sizeof line);
}

/* ---------------------------------------------------------------------------------------------
 * Ultrasonic sensor MB1242: writing 0x51 starts a measurement, then read 2 bytes (cm)
 * ------------------------------------------------------------------------------------------- */
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
 * Keypad 4x3 (Multiplexing)
 *   Idle state: all rows HIGH. When a key is pressed, its column becomes HIGH -> interrupt.
 *   Then the rows are switched HIGH one at a time: the row for which the column stays HIGH
 *   is the row of the pressed key.
 * ------------------------------------------------------------------------------------------- */
static const char keymap[4][3] = {
    { '1', '2', '3' },
    { '4', '5', '6' },
    { '7', '8', '9' },
    { '*', '0', '#' },
};

static void keypad_init(void)
{
    GPIO_PORTK_DIR_R = (GPIO_PORTK_DIR_R | KP_ROWS) & ~KP_COLS;
    GPIO_PORTK_PDR_R |= KP_COLS;                      /* columns: pull-down */
    GPIO_PORTK_DEN_R |= KP_ROWS | KP_COLS;
    GPIO_PORTK_DATA_BITS_R[KP_ROWS] = KP_ROWS;           /* all rows HIGH */

    GPIO_PORTK_IS_R &= ~KP_COLS;                      /* edge */
    GPIO_PORTK_IBE_R &= ~KP_COLS;                     /* only one edge ... */
    GPIO_PORTK_IEV_R |= KP_COLS;                      /* ... namely the rising one */
    GPIO_PORTK_ICR_R = KP_COLS;
    GPIO_PORTK_IM_R |= KP_COLS;
}

static void short_delay(void)
{
    for (volatile int i = 0; i < 50; i++)
    {
    }
}

/* Returns the pressed key or 0 */
static char keypad_scan(void)
{
    char key = 0;
    GPIO_PORTK_IM_R &= ~KP_COLS;                      /* otherwise the scan itself would trigger interrupts */
    for (uint32_t row = 0; row < 4 && key == 0; row++)
    {
        GPIO_PORTK_DATA_BITS_R[KP_ROWS] = 1u << row;
        short_delay();                                    /* let the lines settle */
        uint32_t cols = (GPIO_PORTK_DATA_BITS_R[KP_COLS] & KP_COLS) >> KP_COL_SHIFT;
        for (uint32_t s = 0; s < 3; s++)
        {
            if (cols & (1u << s))
            {
                key = keymap[row][s];
                break;
            }
        }
    }
    GPIO_PORTK_DATA_BITS_R[KP_ROWS] = KP_ROWS;           /* idle state */
    short_delay();
    GPIO_PORTK_ICR_R = KP_COLS;
    GPIO_PORTK_IM_R |= KP_COLS;
    return key;
}

static bool keypad_pressed(void)
{
    return (GPIO_PORTK_DATA_BITS_R[KP_COLS] & KP_COLS) != 0;
}

/* ---------------------------------------------------------------------------------------------
 * Main program
 * ------------------------------------------------------------------------------------------- */
int main(void)
{
    /* Enable the clock of all modules used and wait for "ready" */
    SYSCTL_RCGCGPIO_R |= PORTS_CLOCK;
    SYSCTL_RCGCUART_R |= SYSCTL_RCGCUART_R0;
    SYSCTL_RCGCI2C_R |= SYSCTL_RCGCI2C_R0;
    SYSCTL_RCGCTIMER_R |= SYSCTL_RCGCTIMER_R0;
    while ((SYSCTL_PRGPIO_R & PORTS_READY) != PORTS_READY || (SYSCTL_PRUART_R & SYSCTL_PRUART_R0) == 0 ||
           (SYSCTL_PRI2C_R & SYSCTL_PRI2C_R0) == 0 || (SYSCTL_PRTIMER_R & SYSCTL_PRTIMER_R0) == 0)
    {
    }

    /* LEDs */
    GPIO_PORTN_DIR_R |= LED_D1 | LED_D2;
    GPIO_PORTN_DEN_R |= LED_D1 | LED_D2;
    GPIO_PORTF_AHB_DIR_R |= LED_D3 | LED_D4;
    GPIO_PORTF_AHB_DEN_R |= LED_D3 | LED_D4;

    /* Push buttons: input with pull-up, interrupt on falling edge (= press) */
    GPIO_PORTJ_AHB_DIR_R &= ~(SW1 | SW2);
    GPIO_PORTJ_AHB_PUR_R |= SW1 | SW2;
    GPIO_PORTJ_AHB_DEN_R |= SW1 | SW2;
    GPIO_PORTJ_AHB_IS_R &= ~(SW1 | SW2);
    GPIO_PORTJ_AHB_IBE_R &= ~(SW1 | SW2);
    GPIO_PORTJ_AHB_IEV_R &= ~(SW1 | SW2);
    GPIO_PORTJ_AHB_ICR_R = SW1 | SW2;
    GPIO_PORTJ_AHB_IM_R |= SW1 | SW2;

    uart_init();
    i2c_init();
    keypad_init();

    /* Timer0A: 100 ms periodic */
    TIMER0_CTL_R = 0;
    TIMER0_CFG_R = TIMER_CFG_32_BIT_TIMER;
    TIMER0_TAMR_R = TIMER_TAMR_TAMR_PERIOD;
    TIMER0_TAILR_R = SYSTEM_CLOCK_HZ / 10u - 1u;
    TIMER0_ICR_R = TIMER_ICR_TATOCINT;
    TIMER0_IMR_R |= TIMER_IMR_TATOIM;

    NVIC_EN0_R = 1u << IRQ_TIMER0A;
    NVIC_EN1_R = (1u << (IRQ_GPIOJ - 32u)) | (1u << (IRQ_GPIOK - 32u));
    __asm volatile("cpsie i");
    TIMER0_CTL_R |= TIMER_CTL_TAEN;

    uart_puts("\nrenode4mc-haw - Example 03 Web console\n");
    uart_puts("Use the push buttons, keypad and distance sensor; characters are echoed back.\n");

    oled_init();
    if (!oled_ok)
    {
        uart_puts("OLED does not respond (I2C address 0x3C)\n");
    }
    for (uint8_t p = 0; p < 8; p++)
    {
        oled_text(p, "");
    }
    oled_text(0, "RENODE4MC-HAW");
    oled_text(1, "EXAMPLE 03 WEBCONSOLE");
    oled_text(3, "DISTANCE:  --- CM");
    oled_text(5, "KEY:       -");
    oled_text(7, "UART:      -");

    uint32_t lastTick = 0;
    uint32_t distance = UINT32_MAX;              /* no measurement yet */
    bool keyPressed = false;
    char buf[24];
    char num[8];

    while (1)
    {
        /* --- 100 ms tick: heartbeat, sensor, keypad release -------------------------- */
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
                    utoa_pad(cm, num, 3);
                    const char *prefix = "DISTANCE:  ";
                    int i = 0;
                    for (; prefix[i]; i++) buf[i] = prefix[i];
                    for (int k = 0; num[k]; k++) buf[i++] = num[k];
                    buf[i++] = ' '; buf[i++] = 'C'; buf[i++] = 'M'; buf[i] = '\0';
                    oled_text(3, buf);
                    uart_puts("Distance: ");
                    uart_puts(num);
                    uart_puts(" cm\n");

                    /* D1: proximity warning below 50 cm */
                    GPIO_PORTN_DATA_BITS_R[LED_D1] = (cm < 50u) ? LED_D1 : 0u;
                }
            }

            if (keyPressed && !keypad_pressed())
            {
                keyPressed = false;
                uart_puts("Key released\n");
            }
        }

        /* --- Keypad -------------------------------------------------------------------- */
        if (keypadEvent)
        {
            keypadEvent = false;
            char key = keypad_scan();
            if (key != 0 && !keyPressed)
            {
                keyPressed = true;
                const char text[] = { 'K', 'E', 'Y', ':', ' ', ' ', ' ', ' ', ' ', ' ', ' ', key, '\0' };
                oled_text(5, text);
                uart_puts("Key: ");
                uart_putc(key);
                uart_puts("\n");
            }
        }

        /* --- Push buttons USR_SW1 / USR_SW2 ---------------------------------------------- */
        if (buttonEvents)
        {
            __asm volatile("cpsid i");
            uint32_t ev = buttonEvents;
            buttonEvents = 0;
            __asm volatile("cpsie i");
            if (ev & SW1)
            {
                GPIO_PORTF_AHB_DATA_BITS_R[LED_D3] ^= LED_D3;
                uart_puts("USR_SW1 pressed -> D3 toggled\n");
            }
            if (ev & SW2)
            {
                GPIO_PORTF_AHB_DATA_BITS_R[LED_D4] ^= LED_D4;
                uart_puts("USR_SW2 pressed -> D4 toggled\n");
            }
        }

        /* --- UART echo -------------------------------------------------------------------- */
        char c;
        while (uart_getc(&c))
        {
            uart_putc(c);
            if (c == '\r')
            {
                uart_putc('\n');
            }
            const char text[] = { 'U', 'A', 'R', 'T', ':', ' ', ' ', ' ', ' ', ' ', ' ', c, '\0' };
            oled_text(7, text);
        }

        __asm volatile("wfi");                            /* sleep until the next interrupt */
    }
}
