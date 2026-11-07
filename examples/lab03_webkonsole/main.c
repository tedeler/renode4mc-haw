/*
 * Lab 03 - Web-Konsole: Demo für alle Bedienelemente von Versuch 1 (reiner Registerzugriff)
 * Board: EK-TM4C1294XL (TM4C1294NCPDT), Takt: 16 MHz (Reset-Takt, wird hier nicht verändert)
 *
 * Läuft im Simulator (Web-Konsole, Versuch "versuch1") und auf dem Board mit Zusatz-Hardware.
 *
 *   Baustein                 Anschluss                          Verwendung im Programm
 *   ------------------------ ---------------------------------- -------------------------------------
 *   LEDs D1, D2, D3, D4      PN1, PN0, PF4, PF0 (Ausgang)        D1 = Abstand < 50 cm, D2 = Herzschlag,
 *                                                                D3/D4 = von USR_SW1/USR_SW2 umgeschaltet
 *   Taster USR_SW1, USR_SW2  PJ0, PJ1 (Eingang, Pull-up,        Interrupt bei fallender Flanke (Drücken)
 *                            gedrückt = LOW)
 *   UART0 (Virtual COM)      PA0 = RX, PA1 = TX, 115200 8N1      Meldungen, Echo empfangener Zeichen
 *   I2C0                     PB2 = SCL, PB3 = SDA, 100 kHz       OLED (0x3C) und Ultraschallsensor (0x70)
 *   OLED SSD1306 128x64      I2C0, Adresse 0x3C                  Textanzeige (Abstand, Taste, ...)
 *   Ultraschall MB1242       I2C0, Adresse 0x70                  Messung alle 200 ms
 *   Keypad 4x3               Zeilen PK0..PK3 (Ausgang),          Interrupt an den Spalten, dann Zeilen-Scan
 *                            Spalten PK4..PK6 (Eingang, Pull-down)
 *   Timer0A                  -                                   100-ms-Takt (Interrupt)
 *
 * Registernamen und Bitkonstanten: TI-Headerdatei tm4c1294ncpdt.h (common/), keine eigenen
 * Adressen. Nachschlagen im Datenblatt "TM4C1294NCPDT" (SPMS433).
 */
#include <stdint.h>
#include <stdbool.h>
#include "tm4c1294ncpdt.h"

#define SYSTEM_CLOCK_HZ     16000000u

/* ---------------------------------------------------------------------------------------------
 * Register: alle Namen (..._R) und Bitkonstanten kommen aus tm4c1294ncpdt.h.
 * Hier stehen nur Konstanten, die die Headerdatei nicht kennt (Pins, Pin-Funktionen, IRQs).
 * ------------------------------------------------------------------------------------------- */
/* Bits der benutzten Ports in RCGCGPIO bzw. PRGPIO (A = Bit 0 ... N = Bit 12) */
#define PORTS_TAKT          (SYSCTL_RCGCGPIO_R0 | SYSCTL_RCGCGPIO_R1 | SYSCTL_RCGCGPIO_R5 | \
                             SYSCTL_RCGCGPIO_R8 | SYSCTL_RCGCGPIO_R9 | SYSCTL_RCGCGPIO_R12)
#define PORTS_BEREIT        (SYSCTL_PRGPIO_R0 | SYSCTL_PRGPIO_R1 | SYSCTL_PRGPIO_R5 | \
                             SYSCTL_PRGPIO_R8 | SYSCTL_PRGPIO_R9 | SYSCTL_PRGPIO_R12)

/* GPIOPCTL: je 4 Bit pro Pin wählen die alternative Funktion (Datenblatt, Tabelle
 * "GPIO Pins and Alternate Functions"). Dafür hat die Headerdatei keine Konstanten. */
#define PCTL_MASKE(pin)     (0xFu << (4u * (pin)))
#define PCTL_FUNKTION(pin, f) ((uint32_t)(f) << (4u * (pin)))
#define PCTL_UART0          1u                 /* PA0 = U0RX, PA1 = U0TX */
#define PCTL_I2C0           2u                 /* PB2 = I2C0SCL, PB3 = I2C0SDA */

/* NVIC: INT_... aus der Headerdatei ist die Nummer in der Vektortabelle; der NVIC zählt
 * ab dem ersten Peripherie-Interrupt (Eintrag 16). EN0 = IRQ 0..31, EN1 = IRQ 32..63. */
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

/* Geräteadressen am I2C-Bus (7 Bit) */
#define OLED_ADDR           0x3Cu
#define SONAR_ADDR          0x70u

/* ---------------------------------------------------------------------------------------------
 * Ereignisse aus den Interrupt-Routinen (volatile: werden in ISR und main benutzt)
 * ------------------------------------------------------------------------------------------- */
static volatile uint32_t ticks;            /* 100-ms-Zähler (Timer0A) */
static volatile bool     keypadEvent;      /* Flanke an einer Keypad-Spalte */
static volatile uint32_t buttonEvents;     /* Bit 0 = SW1 gedrückt, Bit 1 = SW2 gedrückt */

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
 * UART0: 115200 Baud bei 16 MHz -> BRD = 16e6 / (16 * 115200) = 8,6806
 *        IBRD = 8, FBRD = round(0,6806 * 64) = 44
 * ------------------------------------------------------------------------------------------- */
#define BAUD_IBRD           8u
#define BAUD_FBRD           44u

static void uart_init(void)
{
    GPIO_PORTA_AHB_AFSEL_R |= PINS_UART0;                  /* PA0, PA1: alternative Funktion ... */
    GPIO_PORTA_AHB_PCTL_R = (GPIO_PORTA_AHB_PCTL_R & ~(PCTL_MASKE(0) | PCTL_MASKE(1)))
                          | PCTL_FUNKTION(0, PCTL_UART0) | PCTL_FUNKTION(1, PCTL_UART0); /* U0RX/U0TX */
    GPIO_PORTA_AHB_DEN_R |= PINS_UART0;

    UART0_CTL_R = 0;                                        /* zum Konfigurieren ausschalten */
    UART0_CC_R = UART_CC_CS_SYSCLK;                         /* Takt = Systemtakt */
    UART0_IBRD_R = BAUD_IBRD;
    UART0_FBRD_R = BAUD_FBRD;
    UART0_LCRH_R = UART_LCRH_WLEN_8 | UART_LCRH_FEN;        /* 8 Datenbits, FIFO an */
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

/* Zahl als Dezimaltext (rechtsbündig in "breite" Zeichen, mit Leerzeichen aufgefüllt) */
static void utoa_pad(uint32_t wert, char *ziel, int breite)
{
    char tmp[11];
    int n = 0;
    do
    {
        tmp[n++] = (char)('0' + wert % 10u);
        wert /= 10u;
    } while (wert != 0u && n < 10);
    int i = 0;
    for (; i < breite - n; i++)
    {
        ziel[i] = ' ';
    }
    while (n > 0)
    {
        ziel[i++] = tmp[--n];
    }
    ziel[i] = '\0';
}

/* ---------------------------------------------------------------------------------------------
 * I2C0 als Master, 100 kHz:  MTPR = SysClk / (2 * (6 + 4) * 100 kHz) - 1 = 7
 * ------------------------------------------------------------------------------------------- */
#define TPR_100KHZ          7u

static void i2c_init(void)
{
    GPIO_PORTB_AHB_AFSEL_R |= PINS_I2C0;                   /* PB2, PB3: alternative Funktion */
    GPIO_PORTB_AHB_ODR_R |= PIN_I2C0_SDA;                      /* SDA (PB3) als Open-Drain */
    GPIO_PORTB_AHB_PCTL_R = (GPIO_PORTB_AHB_PCTL_R & ~(PCTL_MASKE(2) | PCTL_MASKE(3)))
                          | PCTL_FUNKTION(2, PCTL_I2C0) | PCTL_FUNKTION(3, PCTL_I2C0); /* SCL/SDA */
    GPIO_PORTB_AHB_DEN_R |= PINS_I2C0;

    I2C0_MCR_R = I2C_MCR_MFE;                               /* Master-Betrieb */
    I2C0_MTPR_R = TPR_100KHZ;
}

/* Wartet auf das Ende eines Befehls; true = ohne Fehler (Gerät hat quittiert) */
static bool i2c_wait(void)
{
    while (I2C0_MCS_R & I2C_MCS_BUSY)
    {
    }
    return (I2C0_MCS_R & I2C_MCS_ERROR) == 0;
}

/* Schreibt n Bytes an ein Gerät: START, Daten, STOP */
static bool i2c_write(uint8_t addr, const uint8_t *daten, uint32_t n)
{
    I2C0_MSA_R = (uint32_t)addr << I2C_MSA_SA_S;            /* R/S = 0: schreiben */
    for (uint32_t i = 0; i < n; i++)
    {
        I2C0_MDR_R = daten[i];
        uint32_t cmd = I2C_MCS_RUN;
        if (i == 0)     cmd |= I2C_MCS_START;
        if (i == n - 1) cmd |= I2C_MCS_STOP;
        I2C0_MCS_R = cmd;
        if (!i2c_wait())
        {
            I2C0_MCS_R = I2C_MCS_STOP;                      /* Fehler: Bus freigeben */
            return false;
        }
    }
    return true;
}

/* Liest n (>= 2) Bytes von einem Gerät: START, Daten mit ACK, letztes Byte ohne ACK + STOP */
static bool i2c_read(uint8_t addr, uint8_t *daten, uint32_t n)
{
    I2C0_MSA_R = ((uint32_t)addr << I2C_MSA_SA_S) | I2C_MSA_RS; /* R/S = 1: lesen */
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
        daten[i] = (uint8_t)(I2C0_MDR_R & I2C_MDR_DATA_M);
    }
    return true;
}

/* ---------------------------------------------------------------------------------------------
 * OLED SSD1306 (128 x 64, 8 "Pages" zu je 8 Pixelzeilen)
 * Jede I2C-Übertragung beginnt mit einem Steuerbyte: 0x00 = Befehle folgen, 0x40 = Bilddaten.
 * ------------------------------------------------------------------------------------------- */
static bool oled_ok;

static void oled_init(void)
{
    static const uint8_t init[] = {
        0x00,               /* Steuerbyte: Befehle */
        0xAE,               /* Display aus */
        0xD5, 0x80,         /* Taktteiler */
        0xA8, 0x3F,         /* Multiplex 64 Zeilen */
        0xD3, 0x00,         /* kein Versatz */
        0x40,               /* Startzeile 0 */
        0x8D, 0x14,         /* Ladungspumpe an */
        0x20, 0x02,         /* Page-Adressierung */
        0xA1, 0xC8,         /* Spiegelung (Anschlüsse oben) */
        0xDA, 0x12,         /* COM-Pins */
        0x81, 0x7F,         /* Kontrast */
        0xA4, 0xA6,         /* RAM anzeigen, nicht invertiert */
        0xAF                /* Display an */
    };
    oled_ok = i2c_write(OLED_ADDR, init, sizeof init);
}

/* 5x7-Zeichensatz (Spalten, Bit 0 = oben) für die verwendeten Zeichen ' '..'Z' */
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

/* Schreibt eine Textzeile (max. 21 Zeichen) in Page 0..7; der Rest der Zeile wird gelöscht. */
static void oled_text(uint8_t page, const char *text)
{
    if (!oled_ok)
    {
        return;
    }
    const uint8_t pos[] = { 0x00, (uint8_t)(0xB0u | page), 0x00, 0x10 }; /* Page, Spalte 0 */
    i2c_write(OLED_ADDR, pos, sizeof pos);

    uint8_t zeile[1 + 128];
    zeile[0] = 0x40;                                      /* Steuerbyte: Bilddaten */
    uint32_t x = 1;
    for (; *text && x + 6 <= sizeof zeile; text++)
    {
        char c = *text;
        if (c >= 'a' && c <= 'z')
        {
            c = (char)(c - 'a' + 'A');                    /* nur Großbuchstaben im Zeichensatz */
        }
        if (c < ' ' || c > 'Z')
        {
            c = ' ';
        }
        for (int i = 0; i < 5; i++)
        {
            zeile[x++] = font5x7[c - ' '][i];
        }
        zeile[x++] = 0x00;                                /* Abstand zwischen Zeichen */
    }
    while (x < sizeof zeile)
    {
        zeile[x++] = 0x00;
    }
    i2c_write(OLED_ADDR, zeile, sizeof zeile);
}

/* ---------------------------------------------------------------------------------------------
 * Ultraschallsensor MB1242: 0x51 schreiben startet eine Messung, danach 2 Bytes lesen (cm)
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
 *   Ruhezustand: alle Zeilen HIGH. Drückt man eine Taste, wird ihre Spalte HIGH -> Interrupt.
 *   Dann werden die Zeilen einzeln HIGH geschaltet: Die Zeile, bei der die Spalte HIGH bleibt,
 *   ist die Zeile der gedrückten Taste.
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
    GPIO_PORTK_PDR_R |= KP_COLS;                      /* Spalten: Pull-down */
    GPIO_PORTK_DEN_R |= KP_ROWS | KP_COLS;
    GPIO_PORTK_DATA_BITS_R[KP_ROWS] = KP_ROWS;           /* alle Zeilen HIGH */

    GPIO_PORTK_IS_R &= ~KP_COLS;                      /* Flanke */
    GPIO_PORTK_IBE_R &= ~KP_COLS;                     /* nur eine Flanke ... */
    GPIO_PORTK_IEV_R |= KP_COLS;                      /* ... und zwar steigend */
    GPIO_PORTK_ICR_R = KP_COLS;
    GPIO_PORTK_IM_R |= KP_COLS;
}

static void kurz_warten(void)
{
    for (volatile int i = 0; i < 50; i++)
    {
    }
}

/* Liefert die gedrückte Taste oder 0 */
static char keypad_scan(void)
{
    char taste = 0;
    GPIO_PORTK_IM_R &= ~KP_COLS;                      /* Scan löst sonst selbst Interrupts aus */
    for (uint32_t zeile = 0; zeile < 4 && taste == 0; zeile++)
    {
        GPIO_PORTK_DATA_BITS_R[KP_ROWS] = 1u << zeile;
        kurz_warten();                                    /* Leitungen einschwingen lassen */
        uint32_t spalten = (GPIO_PORTK_DATA_BITS_R[KP_COLS] & KP_COLS) >> KP_COL_SHIFT;
        for (uint32_t s = 0; s < 3; s++)
        {
            if (spalten & (1u << s))
            {
                taste = keymap[zeile][s];
                break;
            }
        }
    }
    GPIO_PORTK_DATA_BITS_R[KP_ROWS] = KP_ROWS;           /* Ruhezustand */
    kurz_warten();
    GPIO_PORTK_ICR_R = KP_COLS;
    GPIO_PORTK_IM_R |= KP_COLS;
    return taste;
}

static bool keypad_gedrueckt(void)
{
    return (GPIO_PORTK_DATA_BITS_R[KP_COLS] & KP_COLS) != 0;
}

/* ---------------------------------------------------------------------------------------------
 * Hauptprogramm
 * ------------------------------------------------------------------------------------------- */
int main(void)
{
    /* Takt für alle benutzten Module freigeben und auf "bereit" warten */
    SYSCTL_RCGCGPIO_R |= PORTS_TAKT;
    SYSCTL_RCGCUART_R |= SYSCTL_RCGCUART_R0;
    SYSCTL_RCGCI2C_R |= SYSCTL_RCGCI2C_R0;
    SYSCTL_RCGCTIMER_R |= SYSCTL_RCGCTIMER_R0;
    while ((SYSCTL_PRGPIO_R & PORTS_BEREIT) != PORTS_BEREIT || (SYSCTL_PRUART_R & SYSCTL_PRUART_R0) == 0 ||
           (SYSCTL_PRI2C_R & SYSCTL_PRI2C_R0) == 0 || (SYSCTL_PRTIMER_R & SYSCTL_PRTIMER_R0) == 0)
    {
    }

    /* LEDs */
    GPIO_PORTN_DIR_R |= LED_D1 | LED_D2;
    GPIO_PORTN_DEN_R |= LED_D1 | LED_D2;
    GPIO_PORTF_AHB_DIR_R |= LED_D3 | LED_D4;
    GPIO_PORTF_AHB_DEN_R |= LED_D3 | LED_D4;

    /* Taster: Eingang mit Pull-up, Interrupt bei fallender Flanke (= Drücken) */
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

    /* Timer0A: 100 ms periodisch */
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

    uart_puts("\nrenode4mc-haw - Lab 03 Web-Konsole\n");
    uart_puts("Taster, Keypad und Abstandssensor bedienen; Zeichen werden zurueckgesendet.\n");

    oled_init();
    if (!oled_ok)
    {
        uart_puts("OLED antwortet nicht (I2C-Adresse 0x3C)\n");
    }
    for (uint8_t p = 0; p < 8; p++)
    {
        oled_text(p, "");
    }
    oled_text(0, "RENODE4MC-HAW");
    oled_text(1, "LAB 03 WEBKONSOLE");
    oled_text(3, "ABSTAND:   --- CM");
    oled_text(5, "TASTE:     -");
    oled_text(7, "UART:      -");

    uint32_t letzterTick = 0;
    uint32_t abstand = UINT32_MAX;              /* noch kein Messwert */
    bool tasteGedrueckt = false;
    char puffer[24];
    char zahl[8];

    while (1)
    {
        /* --- 100-ms-Takt: Herzschlag, Sensor, Keypad loslassen ------------------------- */
        if (ticks != letzterTick)
        {
            letzterTick = ticks;

            if (letzterTick % 5u == 0u)
            {
                GPIO_PORTN_DATA_BITS_R[LED_D2] ^= LED_D2;            /* D2: 1 Hz */
            }

            if (letzterTick % 2u == 0u)
            {
                sonar_start();                                    /* Messung anstoßen ... */
            }
            else
            {
                uint32_t cm;
                if (sonar_read(&cm) && cm != abstand)             /* ... 100 ms später lesen */
                {
                    abstand = cm;
                    utoa_pad(cm, zahl, 3);
                    const char *vorne = "ABSTAND:   ";
                    int i = 0;
                    for (; vorne[i]; i++) puffer[i] = vorne[i];
                    for (int k = 0; zahl[k]; k++) puffer[i++] = zahl[k];
                    puffer[i++] = ' '; puffer[i++] = 'C'; puffer[i++] = 'M'; puffer[i] = '\0';
                    oled_text(3, puffer);
                    uart_puts("Abstand: ");
                    uart_puts(zahl);
                    uart_puts(" cm\n");

                    /* D1: Näherungswarnung unter 50 cm */
                    GPIO_PORTN_DATA_BITS_R[LED_D1] = (cm < 50u) ? LED_D1 : 0u;
                }
            }

            if (tasteGedrueckt && !keypad_gedrueckt())
            {
                tasteGedrueckt = false;
                uart_puts("Taste losgelassen\n");
            }
        }

        /* --- Keypad -------------------------------------------------------------------- */
        if (keypadEvent)
        {
            keypadEvent = false;
            char taste = keypad_scan();
            if (taste != 0 && !tasteGedrueckt)
            {
                tasteGedrueckt = true;
                const char text[] = { 'T', 'A', 'S', 'T', 'E', ':', ' ', ' ', ' ', ' ', ' ', taste, '\0' };
                oled_text(5, text);
                uart_puts("Taste: ");
                uart_putc(taste);
                uart_puts("\n");
            }
        }

        /* --- Taster USR_SW1 / USR_SW2 ---------------------------------------------------- */
        if (buttonEvents)
        {
            __asm volatile("cpsid i");
            uint32_t ev = buttonEvents;
            buttonEvents = 0;
            __asm volatile("cpsie i");
            if (ev & SW1)
            {
                GPIO_PORTF_AHB_DATA_BITS_R[LED_D3] ^= LED_D3;
                uart_puts("USR_SW1 gedrueckt -> D3 umgeschaltet\n");
            }
            if (ev & SW2)
            {
                GPIO_PORTF_AHB_DATA_BITS_R[LED_D4] ^= LED_D4;
                uart_puts("USR_SW2 gedrueckt -> D4 umgeschaltet\n");
            }
        }

        /* --- UART-Echo -------------------------------------------------------------------- */
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

        __asm volatile("wfi");                            /* schlafen bis zum nächsten Interrupt */
    }
}
