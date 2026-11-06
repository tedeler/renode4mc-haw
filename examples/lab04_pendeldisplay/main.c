/*
 * Lab 04 - Pendeldisplay: Abstand vom Ultraschallsensor auf einem POV-Pendel anzeigen
 * Board: EK-TM4C1294XL (TM4C1294NCPDT), Takt: 16 MHz (Reset-Takt, wird hier nicht verändert)
 *
 * Läuft im Simulator (Web-Konsole, Versuch "versuch2") und auf dem Board mit Zusatz-Hardware.
 *
 *   Baustein                 Anschluss                          Verwendung im Programm
 *   ------------------------ ---------------------------------- -------------------------------------
 *   Pendeldisplay, 8 LEDs    PM0..PM7 (Ausgang),                 eine Bildspalte = ein Byte auf Port M
 *                            PM0 = LED am Drehpunkt (oben)
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
 *   Das Pendel schwingt 10-mal pro Sekunde (Periode T = 100 ms). Wechselt die Firmware die
 *   LEDs genau dann, wenn das Pendel an der richtigen Stelle ist, sieht das Auge ein stehendes
 *   Bild aus 40 Spalten zu 8 Punkten. Bezugspunkt ist der Nulldurchgang (Flanke an PL0):
 *   Eine halbe Periode nach jeder Flanke läuft das Pendel wieder durch die Mitte, diesmal in
 *   der anderen Richtung. Um diesen Zeitpunkt herum wird eine Bildzeile "geschrieben".
 *
 * Alle Adressen stammen aus dem Datenblatt "TM4C1294NCPDT" (SPMS433).
 */
#include <stdint.h>
#include <stdbool.h>

#define REG(adresse)        (*(volatile uint32_t *)(adresse))
#define SYSTEM_CLOCK_HZ     16000000u

/* ---------------------------------------------------------------------------------------------
 * Register
 * ------------------------------------------------------------------------------------------- */
/* System Control */
#define SYSCTL_RCGCTIMER    REG(0x400FE000 + 0x604)
#define SYSCTL_RCGCGPIO     REG(0x400FE000 + 0x608)
#define SYSCTL_RCGCUART     REG(0x400FE000 + 0x618)
#define SYSCTL_RCGCI2C      REG(0x400FE000 + 0x620)
#define SYSCTL_PRTIMER      REG(0x400FE000 + 0xA04)
#define SYSCTL_PRGPIO       REG(0x400FE000 + 0xA08)
#define SYSCTL_PRUART       REG(0x400FE000 + 0xA18)
#define SYSCTL_PRI2C        REG(0x400FE000 + 0xA20)

/* GPIO: Register-Offsets (gleich für alle Ports) */
#define GPIO_DATA(base)     REG((base) + 0x3FC)            /* alle 8 Bits */
#define GPIO_DATA_M(base,m) REG((base) + ((m) << 2))       /* nur die Bits in Maske m */
#define GPIO_DIR(base)      REG((base) + 0x400)
#define GPIO_IS(base)       REG((base) + 0x404)
#define GPIO_IBE(base)      REG((base) + 0x408)
#define GPIO_IM(base)       REG((base) + 0x410)
#define GPIO_MIS(base)      REG((base) + 0x418)
#define GPIO_ICR(base)      REG((base) + 0x41C)
#define GPIO_AFSEL(base)    REG((base) + 0x420)
#define GPIO_ODR(base)      REG((base) + 0x50C)
#define GPIO_DEN(base)      REG((base) + 0x51C)
#define GPIO_PCTL(base)     REG((base) + 0x52C)

#define GPIOA_BASE          0x40058000u
#define GPIOB_BASE          0x40059000u
#define GPIOL_BASE          0x40062000u
#define GPIOM_BASE          0x40063000u
#define GPION_BASE          0x40064000u

/* Bitnummern der Ports in RCGCGPIO/PRGPIO */
#define PORT_A              (1u << 0)
#define PORT_B              (1u << 1)
#define PORT_L              (1u << 10)
#define PORT_M              (1u << 11)
#define PORT_N              (1u << 12)

/* UART0 */
#define UART0_BASE          0x4000C000u
#define UART0_DR            REG(UART0_BASE + 0x000)
#define UART0_FR            REG(UART0_BASE + 0x018)
#define UART0_IBRD          REG(UART0_BASE + 0x024)
#define UART0_FBRD          REG(UART0_BASE + 0x028)
#define UART0_LCRH          REG(UART0_BASE + 0x02C)
#define UART0_CTL           REG(UART0_BASE + 0x030)
#define UART0_CC            REG(UART0_BASE + 0xFC8)
#define UART_FR_TXFF        (1u << 5)

/* I2C0 (Master) */
#define I2C0_BASE           0x40020000u
#define I2C0_MSA            REG(I2C0_BASE + 0x000)
#define I2C0_MCS            REG(I2C0_BASE + 0x004)
#define I2C0_MDR            REG(I2C0_BASE + 0x008)
#define I2C0_MTPR           REG(I2C0_BASE + 0x00C)
#define I2C0_MCR            REG(I2C0_BASE + 0x020)
#define I2C_MCS_RUN         (1u << 0)
#define I2C_MCS_START       (1u << 1)
#define I2C_MCS_STOP        (1u << 2)
#define I2C_MCS_ACK         (1u << 3)
#define I2C_MCS_BUSY        (1u << 0)
#define I2C_MCS_ERROR       (1u << 1)

/* Timer: Register-Offsets (gleich für alle Timer) */
#define TIMER_CFG(base)     REG((base) + 0x000)
#define TIMER_TAMR(base)    REG((base) + 0x004)
#define TIMER_CTL(base)     REG((base) + 0x00C)
#define TIMER_IMR(base)     REG((base) + 0x018)
#define TIMER_ICR(base)     REG((base) + 0x024)
#define TIMER_TAILR(base)   REG((base) + 0x028)
#define TIMER_TAV(base)     REG((base) + 0x050)            /* aktueller Zählerstand */

#define TIMER0_BASE         0x40030000u
#define TIMER1_BASE         0x40031000u
#define TIMER2_BASE         0x40032000u

/* NVIC */
#define NVIC_ISER0          REG(0xE000E100)    /* IRQ 0..31 */
#define NVIC_ISER1          REG(0xE000E104)    /* IRQ 32..63 */
#define IRQ_TIMER0A         19u
#define IRQ_TIMER1A         21u
#define IRQ_GPIOL           53u

/* Pins */
#define LED_D2              (1u << 0)          /* PN0 */
#define PENDEL_SYNC         (1u << 0)          /* PL0 */
#define PENDEL_LEDS         0xFFu              /* PM0..PM7 */

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

#define PERIODE_SOLL        (SYSTEM_CLOCK_HZ / 10u)        /* 100 ms = 1 600 000 Takte */

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
    int32_t warten = (int32_t)(TIMER_TAV(TIMER2_BASE) - ziel);
    if (warten < 16)
    {
        warten = 16;                                       /* schon vorbei: sofort weiter */
    }
    TIMER_TAILR(TIMER1_BASE) = (uint32_t)warten - 1u;
    TIMER_CTL(TIMER1_BASE) |= 1u;                          /* TAEN */
}

/* Statistik für die UART-Ausgabe */
static volatile uint32_t neuePeriode;                      /* != 0: neu gemessene Periode */

/* ---------------------------------------------------------------------------------------------
 * Interrupt-Routinen
 * ------------------------------------------------------------------------------------------- */
static volatile uint32_t ticks;            /* 100-ms-Zähler (Timer0A) */

void TIMER0A_Handler(void)
{
    TIMER_ICR(TIMER0_BASE) = 1u;
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
    int32_t bisStart = (int32_t)(TIMER_TAV(TIMER2_BASE) - (mitte - (uint32_t)spaltenTakte[0]));
    if (bisStart < 100)
    {
        laeuft = false;                                    /* zu spät: auf die nächste Flanke warten */
        return;
    }
    nachLinks = (GPIO_DATA_M(GPIOL_BASE, PENDEL_SYNC) & PENDEL_SYNC) != 0;
    spalte = 0;
    laeuft = true;
    spaltentimer_auf(0);
}

/* Flanke am Pendel-Signal (PL0) = Pendel läuft durch die Mitte */
void GPIOL_Handler(void)
{
    static uint32_t letzteSteigende;
    static bool     gemessen;                              /* eine steigende Flanke schon gesehen */
    static bool     gemeldet;                              /* Periode schon per UART gemeldet */

    uint32_t jetzt = TIMER_TAV(TIMER2_BASE);               /* Timer2 zählt abwärts */
    GPIO_ICR(GPIOL_BASE) = PENDEL_SYNC;
    bool rechts = (GPIO_DATA_M(GPIOL_BASE, PENDEL_SYNC) & PENDEL_SYNC) != 0;

    if (rechts)
    {
        /* Periode = Abstand zweier steigender Flanken (Abwärtszähler: alt - neu) */
        uint32_t t = letzteSteigende - jetzt;
        letzteSteigende = jetzt;
        if (gemessen && t > PERIODE_SOLL / 2u && t < PERIODE_SOLL * 2u)
        {
            uint32_t abweichung = (t > periode) ? t - periode : periode - t;
            if (abweichung > periode / 1000u)              /* mehr als 0,1 % geändert */
            {
                periode = t;
                zeitplan_berechnen(t);                     /* Zeitplan an die echte Periode anpassen */
                gemeldet = false;
            }
            if (!gemeldet)
            {
                neuePeriode = t;
                gemeldet = true;
            }
        }
        gemessen = true;
    }

    letzteKante = jetzt;
    if (!laeuft)
    {
        schwung_planen();                                  /* Start bzw. nach einer Unterbrechung */
    }
}

/* Einmal-Timer: jetzt beginnt die nächste Spalte */
void TIMER1A_Handler(void)
{
    TIMER_ICR(TIMER1_BASE) = 1u;

    if (spalte >= SPALTEN)
    {
        GPIO_DATA(GPIOM_BASE) = 0;                         /* Bild zu Ende: LEDs aus ... */
        schwung_planen();                                  /* ... und den nächsten Schwung planen */
        return;
    }
    uint32_t index = nachLinks ? (SPALTEN - 1u - spalte) : spalte;
    GPIO_DATA(GPIOM_BASE) = bild[index];
    spalte++;
    spaltentimer_auf(spalte);
}

/* ---------------------------------------------------------------------------------------------
 * UART0: 115200 Baud bei 16 MHz -> IBRD = 8, FBRD = 44 (siehe Lab 03)
 * ------------------------------------------------------------------------------------------- */
static void uart_init(void)
{
    GPIO_AFSEL(GPIOA_BASE) |= 0x03u;
    GPIO_PCTL(GPIOA_BASE) = (GPIO_PCTL(GPIOA_BASE) & ~0xFFu) | 0x11u;
    GPIO_DEN(GPIOA_BASE) |= 0x03u;

    UART0_CTL = 0;
    UART0_CC = 0;
    UART0_IBRD = 8;
    UART0_FBRD = 44;
    UART0_LCRH = (0x3u << 5) | (1u << 4);
    UART0_CTL = (1u << 0) | (1u << 8) | (1u << 9);
}

static void uart_putc(char c)
{
    while (UART0_FR & UART_FR_TXFF)
    {
    }
    UART0_DR = (uint8_t)c;
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
static void i2c_init(void)
{
    GPIO_AFSEL(GPIOB_BASE) |= 0x0Cu;
    GPIO_ODR(GPIOB_BASE) |= 0x08u;
    GPIO_PCTL(GPIOB_BASE) = (GPIO_PCTL(GPIOB_BASE) & ~0xFF00u) | 0x2200u;
    GPIO_DEN(GPIOB_BASE) |= 0x0Cu;

    I2C0_MCR = 0x10u;
    I2C0_MTPR = 7u;
}

static bool i2c_wait(void)
{
    while (I2C0_MCS & I2C_MCS_BUSY)
    {
    }
    return (I2C0_MCS & I2C_MCS_ERROR) == 0;
}

static bool i2c_write(uint8_t addr, const uint8_t *daten, uint32_t n)
{
    I2C0_MSA = (uint32_t)addr << 1;
    for (uint32_t i = 0; i < n; i++)
    {
        I2C0_MDR = daten[i];
        uint32_t cmd = I2C_MCS_RUN;
        if (i == 0)     cmd |= I2C_MCS_START;
        if (i == n - 1) cmd |= I2C_MCS_STOP;
        I2C0_MCS = cmd;
        if (!i2c_wait())
        {
            I2C0_MCS = I2C_MCS_STOP;
            return false;
        }
    }
    return true;
}

static bool i2c_read(uint8_t addr, uint8_t *daten, uint32_t n)
{
    I2C0_MSA = ((uint32_t)addr << 1) | 1u;
    for (uint32_t i = 0; i < n; i++)
    {
        uint32_t cmd = I2C_MCS_RUN;
        if (i == 0)     cmd |= I2C_MCS_START;
        if (i < n - 1)  cmd |= I2C_MCS_ACK;
        else            cmd |= I2C_MCS_STOP;
        I2C0_MCS = cmd;
        if (!i2c_wait())
        {
            I2C0_MCS = I2C_MCS_STOP;
            return false;
        }
        daten[i] = (uint8_t)I2C0_MDR;
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
 * Text -> Bild. 5x7-Zeichensatz (Spalten, Bit 0 = oben = LED am Drehpunkt)
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
    const uint32_t ports = PORT_A | PORT_B | PORT_L | PORT_M | PORT_N;
    const uint32_t timer = (1u << 0) | (1u << 1) | (1u << 2);
    SYSCTL_RCGCGPIO |= ports;
    SYSCTL_RCGCUART |= 1u << 0;
    SYSCTL_RCGCI2C |= 1u << 0;
    SYSCTL_RCGCTIMER |= timer;
    while ((SYSCTL_PRGPIO & ports) != ports || (SYSCTL_PRUART & 1u) == 0 ||
           (SYSCTL_PRI2C & 1u) == 0 || (SYSCTL_PRTIMER & timer) != timer)
    {
    }

    /* LED D2 (Herzschlag) */
    GPIO_DIR(GPION_BASE) |= LED_D2;
    GPIO_DEN(GPION_BASE) |= LED_D2;

    /* Pendel-LEDs: ganzer Port M als Ausgang */
    GPIO_DIR(GPIOM_BASE) |= PENDEL_LEDS;
    GPIO_DEN(GPIOM_BASE) |= PENDEL_LEDS;
    GPIO_DATA(GPIOM_BASE) = 0;

    /* Pendel-Signal PL0: Eingang, Interrupt bei beiden Flanken */
    GPIO_DIR(GPIOL_BASE) &= ~PENDEL_SYNC;
    GPIO_DEN(GPIOL_BASE) |= PENDEL_SYNC;
    GPIO_IS(GPIOL_BASE) &= ~PENDEL_SYNC;                  /* Flanke */
    GPIO_IBE(GPIOL_BASE) |= PENDEL_SYNC;                  /* beide Flanken */
    GPIO_ICR(GPIOL_BASE) = PENDEL_SYNC;
    GPIO_IM(GPIOL_BASE) |= PENDEL_SYNC;

    uart_init();
    i2c_init();

    /* Timer0A: 100 ms periodisch (Sensor, Herzschlag) */
    TIMER_CTL(TIMER0_BASE) = 0;
    TIMER_CFG(TIMER0_BASE) = 0;
    TIMER_TAMR(TIMER0_BASE) = 0x2u;                        /* periodisch */
    TIMER_TAILR(TIMER0_BASE) = SYSTEM_CLOCK_HZ / 10u - 1u;
    TIMER_ICR(TIMER0_BASE) = 1u;
    TIMER_IMR(TIMER0_BASE) |= 1u;

    /* Timer1A: Einmal-Timer für die Spalten (wird in den ISRs gestartet) */
    TIMER_CTL(TIMER1_BASE) = 0;
    TIMER_CFG(TIMER1_BASE) = 0;
    TIMER_TAMR(TIMER1_BASE) = 0x1u;                        /* Einmal-Modus */
    TIMER_ICR(TIMER1_BASE) = 1u;
    TIMER_IMR(TIMER1_BASE) |= 1u;

    /* Timer2A: freilaufend (32 Bit, periodisch, ohne Interrupt) als Zeitbasis */
    TIMER_CTL(TIMER2_BASE) = 0;
    TIMER_CFG(TIMER2_BASE) = 0;
    TIMER_TAMR(TIMER2_BASE) = 0x2u;
    TIMER_TAILR(TIMER2_BASE) = 0xFFFFFFFFu;
    TIMER_CTL(TIMER2_BASE) |= 1u;

    zeitplan_berechnen(periode);
    bild_text("---");

    NVIC_ISER0 = (1u << IRQ_TIMER0A) | (1u << IRQ_TIMER1A);
    NVIC_ISER1 = 1u << (IRQ_GPIOL - 32u);
    __asm volatile("cpsie i");
    TIMER_CTL(TIMER0_BASE) |= 1u;

    uart_puts("\nrenode4mc-haw - Lab 04 Pendeldisplay\n");
    uart_puts("Abstand am Sensor einstellen; er erscheint auf dem Pendel und hier.\n");

    uint32_t letzterTick = 0;
    uint32_t abstand = 0xFFFFFFFFu;
    char text[16];

    while (1)
    {
        if (ticks != letzterTick)
        {
            letzterTick = ticks;

            if (letzterTick % 5u == 0u)
            {
                GPIO_DATA_M(GPION_BASE, LED_D2) ^= LED_D2;            /* D2: 1 Hz */
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
            int n = utoa(p / (SYSTEM_CLOCK_HZ / 10000u), text); /* in 0,1 ms */
            uart_puts("Pendelperiode: ");
            for (int i = 0; i < n - 1; i++) uart_putc(text[i]);
            uart_putc(',');
            uart_putc(text[n - 1]);
            uart_puts(" ms\n");
        }

        __asm volatile("wfi");                            /* schlafen bis zum nächsten Interrupt */
    }
}
