/*
 * Lab 04 - Pendeldisplay: Abstand vom Ultraschallsensor auf einem POV-Pendel anzeigen
 * Board: EK-TM4C1294XL (TM4C1294NCPDT), Takt: 16 MHz (Reset-Takt, wird hier nicht verändert)
 *
 * Läuft im Simulator (Web-Konsole, Versuch "versuch2") und auf dem Board mit Zusatz-Hardware.
 *
 *   Baustein                 Anschluss                          Verwendung im Programm
 *   ------------------------ ---------------------------------- -------------------------------------
 *   Pendeldisplay, 8 LEDs    PM0..PM7 (Ausgang),                 eine Bildspalte = ein Byte auf Port M
 *                            Drehpunkt unten, PM0 = LED an der
 *                            Spitze (oben), PM7 = LED unten
 *   Pendel-Signal            PL0 (Eingang)                       HIGH = Pendel rechts, LOW = links;
 *                                                                Interrupt bei beiden Flanken
 *   UART0 (Virtual COM)      PA0 = RX, PA1 = TX, 115200 8N1      Meldungen (Abstand, Pendelperiode)
 *   I2C0                     PB2 = SCL, PB3 = SDA, 100 kHz       Ultraschallsensor MB1242 (0x70)
 *   LED D2                   PN0 (Ausgang)                       Herzschlag 1 Hz
 *   Timer0A                  -                                   100-ms-Takt (Sensor, Herzschlag)
 *   Timer1A                  -                                   Einmal-Timer: Zeitpunkt der nächsten Bildspalte
 *   Timer2A                  -                                   freilaufend, misst die Pendelperiode
 *
 * Prinzip (POV = persistence of vision):
 *   Das Pendel schwingt 10-mal pro Sekunde (Periode T = 100 ms; in der Web-Konsole einstellbar,
 *   die Firmware misst T laufend nach und akzeptiert 0,1..50 Hz). Wechselt die Firmware die
 *   LEDs genau dann, wenn das Pendel an der richtigen Stelle ist, sieht das Auge ein stehendes
 *   Bild aus 40 Spalten zu 8 Punkten. Bezugspunkt ist der Nulldurchgang (Flanke an PL0):
 *   Eine halbe Periode nach jeder Flanke läuft das Pendel wieder durch die Mitte, diesmal in
 *   der anderen Richtung. Um diesen Zeitpunkt herum wird eine Bildzeile "geschrieben".
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
/* Bits der benutzten Module in RCGC... bzw. PR... */
#define PORTS_TAKT          (SYSCTL_RCGCGPIO_R0 | SYSCTL_RCGCGPIO_R1 | SYSCTL_RCGCGPIO_R10 | \
                             SYSCTL_RCGCGPIO_R11 | SYSCTL_RCGCGPIO_R12)            /* A, B, L, M, N */
#define PORTS_BEREIT        (SYSCTL_PRGPIO_R0 | SYSCTL_PRGPIO_R1 | SYSCTL_PRGPIO_R10 | \
                             SYSCTL_PRGPIO_R11 | SYSCTL_PRGPIO_R12)
#define TIMER_TAKT          (SYSCTL_RCGCTIMER_R0 | SYSCTL_RCGCTIMER_R1 | SYSCTL_RCGCTIMER_R2)
#define TIMER_BEREIT        (SYSCTL_PRTIMER_R0 | SYSCTL_PRTIMER_R1 | SYSCTL_PRTIMER_R2)

/* GPIOPCTL: je 4 Bit pro Pin wählen die alternative Funktion (Datenblatt, Tabelle
 * "GPIO Pins and Alternate Functions"). Dafür hat die Headerdatei keine Konstanten. */
#define PCTL_MASKE(pin)     (0xFu << (4u * (pin)))
#define PCTL_FUNKTION(pin, f) ((uint32_t)(f) << (4u * (pin)))
#define PCTL_UART0          1u                 /* PA0 = U0RX, PA1 = U0TX */
#define PCTL_I2C0           2u                 /* PB2 = I2C0SCL, PB3 = I2C0SDA */

/* NVIC: INT_... aus der Headerdatei ist die Nummer in der Vektortabelle; der NVIC zählt
 * ab dem ersten Peripherie-Interrupt (Eintrag 16). EN0 = IRQ 0..31, EN1 = IRQ 32..63. */
#define IRQ_TIMER0A         (INT_TIMER0A - 16u)   /* 19 */
#define IRQ_TIMER1A         (INT_TIMER1A - 16u)   /* 21 */
#define IRQ_GPIOL           (INT_GPIOL - 16u)     /* 53 */

/* Pins */
#define LED_D2              (1u << 0)          /* PN0 */
#define PENDEL_SYNC         (1u << 0)          /* PL0 */
#define PENDEL_LEDS         0xFFu              /* PM0..PM7 */
#define PINS_UART0          0x03u              /* PA0 = U0RX, PA1 = U0TX */
#define PINS_I2C0           0x0Cu              /* PB2 = I2C0SCL, PB3 = I2C0SDA */
#define PIN_I2C0_SDA        0x08u              /* PB3 */

/* Geräteadresse am I2C-Bus (7 Bit) */
#define SONAR_ADDR          0x70u

/* ---------------------------------------------------------------------------------------------
 * Pendeldisplay: Bild und Zeitplan
 *
 * Das Bild hat SPALTEN Spalten. Spalte k liegt zwischen den Auslenkungen x(k) und x(k+1) mit
 *     x(k) = -0,9 + 1,8 * k / SPALTEN        (x = -1: ganz links, x = +1: ganz rechts)
 * Die äußeren 10 % des Schwenkbereichs bleiben frei: Dort ist das Pendel sehr langsam und die
 * Spalten würden zu breit.
 *
 * Das Pendel bewegt sich nicht gleichmäßig, sondern wie x(t) = sin(2*pi*t/T). Die Spalte k
 * beginnt also zur Zeit  t(k) = asin(x(k)) / (2*pi) * T  (gemessen ab dem Nulldurchgang).
 * Die Tabelle enthält t(k)/T in Einheiten von 1/65536 der Periode, berechnet mit
 *     python3 -c "import math; print([round(math.asin(-0.9+1.8*k/40)/(2*math.pi)*65536) for k in range(41)])"
 * Sie gilt für beide Schwungrichtungen: Beim Schwung von rechts nach links wird nur die
 * Reihenfolge der Spalten umgedreht.
 * ------------------------------------------------------------------------------------------- */
#define SPALTEN             40u

static const int16_t spaltenZeit_q16[SPALTEN + 1] = {
    -11680, -10697,  -9848,  -9085,  -8384,  -7729,  -7109,  -6518,  -5950,  -5401,
     -4869,  -4349,  -3841,  -3342,  -2852,  -2367,  -1888,  -1412,   -940,   -470,
         0,    470,    940,   1412,   1888,   2367,   2852,   3342,   3841,   4349,
      4869,   5401,   5950,   6518,   7109,   7729,   8384,   9085,   9848,  10697,
     11680,
};

#define PERIODE_SOLL        (SYSTEM_CLOCK_HZ / 10u)        /* 10 Hz: 100 ms = 1 600 000 Takte */
#define PERIODE_MIN         (SYSTEM_CLOCK_HZ / 50u)        /* schnellstes Pendel: 50 Hz */
#define PERIODE_MAX         (SYSTEM_CLOCK_HZ * 10u)        /* langsamstes Pendel: 0,1 Hz (10 s) */

static volatile uint8_t  bild[SPALTEN];                    /* Bit n = LED n (PMn), Bit 0 oben */
static volatile uint32_t periode = PERIODE_SOLL;           /* gemessene Pendelperiode in Takten */
static int32_t           spaltenTakte[SPALTEN + 1];        /* t(k) in Takten, aus periode berechnet */

/* Zustand des Bildaufbaus (nur in den Interrupt-Routinen benutzt) */
static uint32_t spalte;                                    /* nächste Spalte 0..SPALTEN */
static bool     nachLinks;                                 /* true: Schwung von rechts nach links */
static bool     laeuft;                                    /* Timer1A ist für einen Schwung geplant */
static uint32_t letzteKante;                               /* Timer2-Stand bei der letzten Flanke */
static uint32_t mitte;                                     /* Timer2-Stand beim nächsten Nulldurchgang */

static void zeitplan_berechnen(uint32_t takte)
{
    for (uint32_t k = 0; k <= SPALTEN; k++)
    {
        spaltenTakte[k] = (int32_t)(((int64_t)spaltenZeit_q16[k] * (int64_t)takte) / 65536);
    }
}

/*
 * Stellt den Einmal-Timer (Timer1A) auf den Beginn von Spalte k.
 * Der Zeitpunkt wird ABSOLUT auf der Zeitbasis Timer2 gerechnet (Mitte + t(k)) und nicht
 * relativ zur vorigen Spalte: Sonst addiert sich die Verzögerung jeder Interrupt-Routine
 * über alle 40 Spalten, und das Bild verschiebt sich (beim Hin- und Rückschwung gegenläufig).
 * Timer2 zählt ABWÄRTS: "später" heißt "kleinerer Zählerstand".
 */
static void spaltentimer_auf(uint32_t k)
{
    uint32_t ziel = mitte - (uint32_t)spaltenTakte[k];
    int32_t warten = (int32_t)(TIMER2_TAV_R - ziel);
    if (warten < 16)
    {
        warten = 16;                                       /* schon vorbei: sofort weiter */
    }
    TIMER1_TAILR_R = (uint32_t)warten - 1u;
    TIMER1_CTL_R |= TIMER_CTL_TAEN;
}

/* Statistik für die UART-Ausgabe */
static volatile uint32_t neuePeriode;                      /* != 0: neu gemessene Periode */

/* ---------------------------------------------------------------------------------------------
 * Interrupt-Routinen
 * ------------------------------------------------------------------------------------------- */
static volatile uint32_t ticks;            /* 100-ms-Zähler (Timer0A) */

void TIMER0A_Handler(void)
{
    TIMER0_ICR_R = TIMER_ICR_TATOCINT;
    ticks++;
}

/*
 * Plant den nächsten Schwung durch die Mitte.
 *   Pendel rechts (PL0 HIGH): der nächste Durchgang geht nach LINKS
 *   Pendel links  (PL0 LOW):  der nächste Durchgang geht nach RECHTS
 * Dieser Durchgang liegt eine halbe Periode nach der letzten Flanke; die erste Spalte beginnt
 * t(0) Takte davor (t(0) ist negativ). Die Flanke selbst liegt also MITTEN im Schwung -
 * deshalb wird der nächste Schwung erst geplant, wenn der vorige fertig ist.
 */
static void schwung_planen(void)
{
    mitte = letzteKante - periode / 2u;                    /* eine halbe Periode nach der Flanke */
    int32_t bisStart = (int32_t)(TIMER2_TAV_R - (mitte - (uint32_t)spaltenTakte[0]));
    if (bisStart < 100)
    {
        laeuft = false;                                    /* zu spät: auf die nächste Flanke warten */
        return;
    }
    nachLinks = (GPIO_PORTL_DATA_BITS_R[PENDEL_SYNC] & PENDEL_SYNC) != 0;
    spalte = 0;
    laeuft = true;
    spaltentimer_auf(0);
}

/* Flanke am Pendel-Signal (PL0) = Pendel läuft durch die Mitte */
void GPIOL_Handler(void)
{
    static bool gemessen;                                  /* schon eine Flanke gesehen */
    static bool gemeldet;                                  /* Periode schon per UART gemeldet */

    uint32_t jetzt = TIMER2_TAV_R;               /* Timer2 zählt abwärts */
    GPIO_PORTL_ICR_R = PENDEL_SYNC;

    /*
     * Periode = 2 x Abstand zweier aufeinanderfolgender Flanken (eine halbe Schwingung).
     * Das rastet doppelt so schnell ein wie die Messung von steigender zu steigender Flanke -
     * wichtig bei langsamen Pendeln (0,1 Hz: 10 s pro Schwingung).
     */
    uint32_t t = 2u * (letzteKante - jetzt);               /* Abwärtszähler: alt - neu */
    if (gemessen && t >= PERIODE_MIN && t <= PERIODE_MAX)  /* Störungen ignorieren */
    {
        uint32_t abweichung = (t > periode) ? t - periode : periode - t;
        if (abweichung > periode / 1000u)                  /* mehr als 0,1 % geändert */
        {
            periode = t;
            zeitplan_berechnen(t);                         /* Zeitplan an die echte Periode anpassen */
            gemeldet = false;
        }
        if (!gemeldet)
        {
            neuePeriode = t;
            gemeldet = true;
        }
    }
    gemessen = true;

    letzteKante = jetzt;
    if (!laeuft)
    {
        schwung_planen();                                  /* Start bzw. nach einer Unterbrechung */
    }
}

/* Einmal-Timer: jetzt beginnt die nächste Spalte */
void TIMER1A_Handler(void)
{
    TIMER1_ICR_R = TIMER_ICR_TATOCINT;

    if (spalte >= SPALTEN)
    {
        GPIO_PORTM_DATA_R = 0;                         /* Bild zu Ende: LEDs aus ... */
        schwung_planen();                                  /* ... und den nächsten Schwung planen */
        return;
    }
    uint32_t index = nachLinks ? (SPALTEN - 1u - spalte) : spalte;
    GPIO_PORTM_DATA_R = bild[index];
    spalte++;
    spaltentimer_auf(spalte);
}

/* ---------------------------------------------------------------------------------------------
 * UART0: 115200 Baud bei 16 MHz -> IBRD = 8, FBRD = 44 (siehe Lab 03)
 * ------------------------------------------------------------------------------------------- */
#define BAUD_IBRD           8u
#define BAUD_FBRD           44u

static void uart_init(void)
{
    GPIO_PORTA_AHB_AFSEL_R |= PINS_UART0;
    GPIO_PORTA_AHB_PCTL_R = (GPIO_PORTA_AHB_PCTL_R & ~(PCTL_MASKE(0) | PCTL_MASKE(1)))
                          | PCTL_FUNKTION(0, PCTL_UART0) | PCTL_FUNKTION(1, PCTL_UART0);
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

/* Zahl als Dezimaltext ohne führende Leerzeichen; liefert die Anzahl Zeichen */
static int utoa(uint32_t wert, char *ziel)
{
    char tmp[11];
    int n = 0;
    do
    {
        tmp[n++] = (char)('0' + wert % 10u);
        wert /= 10u;
    } while (wert != 0u);
    for (int i = 0; i < n; i++)
    {
        ziel[i] = tmp[n - 1 - i];
    }
    ziel[n] = '\0';
    return n;
}

/* ---------------------------------------------------------------------------------------------
 * I2C0 als Master, 100 kHz (siehe Lab 03)
 * ------------------------------------------------------------------------------------------- */
#define TPR_100KHZ          7u

static void i2c_init(void)
{
    GPIO_PORTB_AHB_AFSEL_R |= PINS_I2C0;
    GPIO_PORTB_AHB_ODR_R |= PIN_I2C0_SDA;
    GPIO_PORTB_AHB_PCTL_R = (GPIO_PORTB_AHB_PCTL_R & ~(PCTL_MASKE(2) | PCTL_MASKE(3)))
                          | PCTL_FUNKTION(2, PCTL_I2C0) | PCTL_FUNKTION(3, PCTL_I2C0);
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

static bool i2c_write(uint8_t addr, const uint8_t *daten, uint32_t n)
{
    I2C0_MSA_R = (uint32_t)addr << I2C_MSA_SA_S;
    for (uint32_t i = 0; i < n; i++)
    {
        I2C0_MDR_R = daten[i];
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

static bool i2c_read(uint8_t addr, uint8_t *daten, uint32_t n)
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
        daten[i] = (uint8_t)(I2C0_MDR_R & I2C_MDR_DATA_M);
    }
    return true;
}

/* Ultraschallsensor MB1242: 0x51 schreiben startet eine Messung, danach 2 Bytes lesen (cm) */
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
 * Text -> Bild. 5x7-Zeichensatz (Spalten, Bit 0 = oben = LED an der Pendelspitze)
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
    { 0x3E, 0x41, 0x41, 0x41, 0x22 },   /* C (Index 10) */
    { 0x7F, 0x02, 0x0C, 0x02, 0x7F },   /* M (Index 11) */
    { 0x08, 0x08, 0x08, 0x08, 0x08 },   /* - (Index 12) */
    { 0x00, 0x00, 0x00, 0x00, 0x00 },   /* Leerzeichen (Index 13) */
};

static uint32_t zeichen_index(char c)
{
    if (c >= '0' && c <= '9') return (uint32_t)(c - '0');
    if (c == 'C') return 10u;
    if (c == 'M') return 11u;
    if (c == '-') return 12u;
    return 13u;
}

/* Schreibt den Text zentriert ins Bild (6 Spalten pro Zeichen, max. 6 Zeichen) */
static void bild_text(const char *text)
{
    uint8_t neu[SPALTEN] = { 0 };
    uint32_t n = 0;
    while (text[n] && n < SPALTEN / 6u)
    {
        n++;
    }
    uint32_t x = (SPALTEN - (n * 6u - 1u)) / 2u;          /* links auffüllen = zentrieren */
    for (uint32_t i = 0; i < n; i++)
    {
        const uint8_t *z = font5x7[zeichen_index(text[i])];
        for (uint32_t s = 0; s < 5u; s++)
        {
            neu[x++] = z[s];
        }
        x++;                                               /* Abstand zwischen Zeichen */
    }
    for (uint32_t k = 0; k < SPALTEN; k++)
    {
        bild[k] = neu[k];
    }
}

/* ---------------------------------------------------------------------------------------------
 * Hauptprogramm
 * ------------------------------------------------------------------------------------------- */
int main(void)
{
    SYSCTL_RCGCGPIO_R |= PORTS_TAKT;
    SYSCTL_RCGCUART_R |= SYSCTL_RCGCUART_R0;
    SYSCTL_RCGCI2C_R |= SYSCTL_RCGCI2C_R0;
    SYSCTL_RCGCTIMER_R |= TIMER_TAKT;
    while ((SYSCTL_PRGPIO_R & PORTS_BEREIT) != PORTS_BEREIT || (SYSCTL_PRUART_R & SYSCTL_PRUART_R0) == 0 ||
           (SYSCTL_PRI2C_R & SYSCTL_PRI2C_R0) == 0 || (SYSCTL_PRTIMER_R & TIMER_BEREIT) != TIMER_BEREIT)
    {
    }

    /* LED D2 (Herzschlag) */
    GPIO_PORTN_DIR_R |= LED_D2;
    GPIO_PORTN_DEN_R |= LED_D2;

    /* Pendel-LEDs: ganzer Port M als Ausgang */
    GPIO_PORTM_DIR_R |= PENDEL_LEDS;
    GPIO_PORTM_DEN_R |= PENDEL_LEDS;
    GPIO_PORTM_DATA_R = 0;

    /* Pendel-Signal PL0: Eingang, Interrupt bei beiden Flanken */
    GPIO_PORTL_DIR_R &= ~PENDEL_SYNC;
    GPIO_PORTL_DEN_R |= PENDEL_SYNC;
    GPIO_PORTL_IS_R &= ~PENDEL_SYNC;                  /* Flanke */
    GPIO_PORTL_IBE_R |= PENDEL_SYNC;                  /* beide Flanken */
    GPIO_PORTL_ICR_R = PENDEL_SYNC;
    GPIO_PORTL_IM_R |= PENDEL_SYNC;

    uart_init();
    i2c_init();

    /* Timer0A: 100 ms periodisch (Sensor, Herzschlag) */
    TIMER0_CTL_R = 0;
    TIMER0_CFG_R = TIMER_CFG_32_BIT_TIMER;
    TIMER0_TAMR_R = TIMER_TAMR_TAMR_PERIOD;
    TIMER0_TAILR_R = SYSTEM_CLOCK_HZ / 10u - 1u;
    TIMER0_ICR_R = TIMER_ICR_TATOCINT;
    TIMER0_IMR_R |= TIMER_IMR_TATOIM;

    /* Timer1A: Einmal-Timer für die Spalten (wird in den ISRs gestartet) */
    TIMER1_CTL_R = 0;
    TIMER1_CFG_R = TIMER_CFG_32_BIT_TIMER;
    TIMER1_TAMR_R = TIMER_TAMR_TAMR_1_SHOT;
    TIMER1_ICR_R = TIMER_ICR_TATOCINT;
    TIMER1_IMR_R |= TIMER_IMR_TATOIM;

    /* Timer2A: freilaufend (32 Bit, periodisch, ohne Interrupt) als Zeitbasis */
    TIMER2_CTL_R = 0;
    TIMER2_CFG_R = TIMER_CFG_32_BIT_TIMER;
    TIMER2_TAMR_R = TIMER_TAMR_TAMR_PERIOD;
    TIMER2_TAILR_R = TIMER_TAILR_M;               /* größter Startwert: läuft ~268 s */
    TIMER2_CTL_R |= TIMER_CTL_TAEN;

    zeitplan_berechnen(periode);
    bild_text("---");

    NVIC_EN0_R = (1u << IRQ_TIMER0A) | (1u << IRQ_TIMER1A);
    NVIC_EN1_R = 1u << (IRQ_GPIOL - 32u);
    __asm volatile("cpsie i");
    TIMER0_CTL_R |= TIMER_CTL_TAEN;

    uart_puts("\nrenode4mc-haw - Lab 04 Pendeldisplay\n");
    uart_puts("Abstand am Sensor einstellen; er erscheint auf dem Pendel und hier.\n");

    uint32_t letzterTick = 0;
    uint32_t abstand = UINT32_MAX;              /* noch kein Messwert */
    char text[16];

    while (1)
    {
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
                    int n = utoa(cm, text);
                    text[n] = 'C';
                    text[n + 1] = 'M';
                    text[n + 2] = '\0';
                    bild_text(text);

                    uart_puts("Abstand: ");
                    text[n] = '\0';
                    uart_puts(text);
                    uart_puts(" cm\n");
                }
            }
        }

        if (neuePeriode)
        {
            uint32_t p = neuePeriode;
            neuePeriode = 0;
            const uint32_t takteJe100us = SYSTEM_CLOCK_HZ / 10000u;
            int n = utoa((p + takteJe100us / 2u) / takteJe100us, text); /* in 0,1 ms, gerundet */
            uart_puts("Pendelperiode: ");
            for (int i = 0; i < n - 1; i++) uart_putc(text[i]);
            uart_putc(',');
            uart_putc(text[n - 1]);
            uart_puts(" ms\n");
        }

        __asm volatile("wfi");                            /* schlafen bis zum nächsten Interrupt */
    }
}
