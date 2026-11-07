/*
 * Lab 06 - LED-Pendel mit Ultraschallmodul HC-SR04 (Praktikum Mikroprozessortechnik, Exercise 6)
 * Board: EK-TM4C1294XL (TM4C1294NCPDT), Takt: 16 MHz (Reset-Takt, wird hier nicht verändert)
 *
 * Läuft im Simulator (Web-Konsole, Versuch "lab2_pendel") und auf dem Board mit dem LED-Pendel
 * "Swinging LED" und dem Ultraschallmodul des HAW-Labors. Aufbau wie Bild 1 im Laborskript:
 *
 *   Baustein                 Anschluss                          Verwendung im Programm
 *   ------------------------ ---------------------------------- -------------------------------------
 *   LED-Pendel, 8 LEDs       PM0..PM7 (Ausgang, HIGH = an)       eine Bildspalte = ein Byte auf Port M,
 *                            LED 7 = PM7 ist die OBERSTE LED     Bit 7 = oben
 *   Signal R/L               PL0 (Eingang)                       steigende Flanke = linker Umkehrpunkt,
 *                                                                fallende Flanke = rechter Umkehrpunkt
 *   Ultraschall HC-SR04      PD0 = Trigger (Ausgang)             fallende Flanke startet die Messung
 *                            PD1 = Echo (Eingang)                HIGH-Dauer = Laufzeit hin und zurück
 *   Timer2A                  -                                   freilaufend (32 Bit, abwärts): Zeitbasis
 *   CCS-Konsole              printf()                            gemessener Abstand
 *
 * Aufgaben aus dem Laborskript, alle mit Abfrage (Polling) gelöst – das Lab "NVIC"
 * (Beispiel lab07_nvic_pendel) ersetzt das später durch Interrupts:
 *   1.   Schmale senkrechte Balken am linken und rechten Rand des Pendelbereichs;
 *        Umkehrpunkte durch ständiges Abfragen von R/L erkennen
 *   2.   Laufende Abstandsmessung mit einem Timer, 2.b Ausgabe mit printf()
 *   3.b  Abstand als Zahl auf dem Pendel (z. B. " 65cm")
 * Hinweis aus dem Skript: Ein Schwung (links -> rechts) zeigt das Bild, im anderen Schwung
 * (rechts -> links) wird gemessen.
 *
 * Bildaufbau (wie in lab04_pendeldisplay): Das Pendel bewegt sich nicht gleichmäßig. Zwischen
 * linkem (t = 0) und rechtem Umkehrpunkt (t = Th, halbe Periode, ca. 60 ms) ist die Auslenkung
 *     x(t) = -cos(pi * t / Th)          (x = -1 ganz links, x = +1 ganz rechts)
 * Eine Stelle x wird also zur Zeit  t(x) = Th * acos(-x) / pi  überstrichen. Die Tabelle
 * ereignisZeit_q16 enthält t/Th (Einheit 1/65536) für alle Stellen, an denen sich die LEDs
 * ändern: Balken links, 40 Textspalten (x = -0,8 .. +0,8), Balken rechts. Berechnet mit
 *     python3 -c "import math; ..."  (siehe README.md)
 * Die Zeitpunkte werden ABSOLUT ab dem linken Umkehrpunkt gerechnet (wie lab04), damit sich
 * keine Verzögerungen aufaddieren. Th wird bei jedem Schwung neu gemessen (ca. 8,3 Hz).
 *
 * Alle Adressen stammen aus dem Datenblatt "TM4C1294NCPDT" (SPMS433).
 */
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>

#define REG(adresse)        (*(volatile uint32_t *)(adresse))
#define SYSTEM_CLOCK_HZ     16000000u
#define TAKTE_PRO_US        (SYSTEM_CLOCK_HZ / 1000000u)

/* ---------------------------------------------------------------------------------------------
 * Register
 * ------------------------------------------------------------------------------------------- */
#define SYSCTL_RCGCTIMER    REG(0x400FE000 + 0x604)
#define SYSCTL_RCGCGPIO     REG(0x400FE000 + 0x608)
#define SYSCTL_PRTIMER      REG(0x400FE000 + 0xA04)
#define SYSCTL_PRGPIO       REG(0x400FE000 + 0xA08)

#define GPIO_DATA(base)     REG((base) + 0x3FC)
#define GPIO_DATA_M(base,m) REG((base) + ((m) << 2))
#define GPIO_DIR(base)      REG((base) + 0x400)
#define GPIO_DEN(base)      REG((base) + 0x51C)

#define GPIOD_BASE          0x4005B000u
#define GPIOL_BASE          0x40062000u
#define GPIOM_BASE          0x40063000u
#define PORT_D              (1u << 3)
#define PORT_L              (1u << 10)
#define PORT_M              (1u << 11)

#define TIMER_CFG(base)     REG((base) + 0x000)
#define TIMER_TAMR(base)    REG((base) + 0x004)
#define TIMER_CTL(base)     REG((base) + 0x00C)
#define TIMER_TAILR(base)   REG((base) + 0x028)
#define TIMER_TAV(base)     REG((base) + 0x050)
#define TIMER2_BASE         0x40032000u
#define TIMER_2             (1u << 2)

/* Pins */
#define PENDEL_LEDS         0xFFu              /* PM0..PM7 */
#define PENDEL_RL           (1u << 0)          /* PL0 */
#define US_TRIGGER          (1u << 0)          /* PD0 */
#define US_ECHO             (1u << 1)          /* PD1 */

/* ---------------------------------------------------------------------------------------------
 * Zeitbasis: Timer2A läuft frei abwärts mit 16 MHz. "jetzt() - alt" ist dann NEGATIV gezählt,
 * deshalb rechnet vergangen() mit alt - jetzt (funktioniert auch über den Überlauf hinweg).
 * ------------------------------------------------------------------------------------------- */
static inline uint32_t jetzt(void)
{
    return TIMER_TAV(TIMER2_BASE);
}

static inline uint32_t vergangen(uint32_t seit)
{
    return seit - jetzt();
}

static void warte_takte(uint32_t takte)
{
    uint32_t start = jetzt();
    while (vergangen(start) < takte)
    {
    }
}

static inline bool rl(void)
{
    return (GPIO_DATA_M(GPIOL_BASE, PENDEL_RL) & PENDEL_RL) != 0;
}

/* ---------------------------------------------------------------------------------------------
 * Bild: Balken links, 40 Textspalten, Balken rechts (Zeitpunkte siehe oben)
 * ------------------------------------------------------------------------------------------- */
#define SPALTEN             40u
#define EREIGNISSE          (2u + SPALTEN + 1u + 2u)

static const uint16_t ereignisZeit_q16[EREIGNISSE] = {
     3618,  7263,                                             /* Balken links an / aus */
    12694, 14122, 15437, 16667, 17831, 18940, 20005, 21033, 22030, 23001,
    23949, 24879, 25792, 26692, 27580, 28458, 29329, 30194, 31054, 31912,
    32768, 33624, 34482, 35342, 36207, 37078, 37956, 38844, 39744, 40657,
    41587, 42535, 43506, 44503, 45531, 46596, 47705, 48869, 50099, 51414,
    52842,                                                    /* Ende der letzten Textspalte */
    58273, 61918,                                             /* Balken rechts an / aus */
};

static uint8_t muster[EREIGNISSE];                            /* LEDs ab dem jeweiligen Zeitpunkt */

/* 5x7-Zeichensatz, Spalten, Bit 0 = oberste Zeile */
static const uint8_t font5x7[][5] = {
    { 0x3E, 0x51, 0x49, 0x45, 0x3E }, { 0x00, 0x42, 0x7F, 0x40, 0x00 },   /* 0 1 */
    { 0x42, 0x61, 0x51, 0x49, 0x46 }, { 0x21, 0x41, 0x45, 0x4B, 0x31 },   /* 2 3 */
    { 0x18, 0x14, 0x12, 0x7F, 0x10 }, { 0x27, 0x45, 0x45, 0x45, 0x39 },   /* 4 5 */
    { 0x3C, 0x4A, 0x49, 0x49, 0x30 }, { 0x01, 0x71, 0x09, 0x05, 0x03 },   /* 6 7 */
    { 0x36, 0x49, 0x49, 0x49, 0x36 }, { 0x06, 0x49, 0x49, 0x29, 0x1E },   /* 8 9 */
    { 0x38, 0x44, 0x44, 0x44, 0x20 },                                     /* c (10) */
    { 0x7C, 0x04, 0x18, 0x04, 0x78 },                                     /* m (11) */
    { 0x08, 0x08, 0x08, 0x08, 0x08 },                                     /* - (12) */
    { 0x00, 0x00, 0x00, 0x00, 0x00 },                                     /* Leerzeichen (13) */
};

static uint32_t zeichen_index(char c)
{
    if (c >= '0' && c <= '9') return (uint32_t)(c - '0');
    if (c == 'c') return 10u;
    if (c == 'm') return 11u;
    if (c == '-') return 12u;
    return 13u;
}

/* Zeichensatz (Bit 0 oben) -> Port M (LED 7 = PM7 oben): Bits spiegeln */
static uint8_t spiegeln(uint8_t b)
{
    uint8_t r = 0;
    for (uint32_t i = 0; i < 8u; i++)
    {
        if (b & (1u << i)) r |= (uint8_t)(0x80u >> i);
    }
    return r;
}

/* Text zentriert in die 40 Spalten, Balken an den Rändern */
static void bild_setzen(const char *text)
{
    uint8_t spalten[SPALTEN] = { 0 };
    uint32_t n = 0;
    while (text[n] && n < SPALTEN / 6u) n++;
    uint32_t x = n ? (SPALTEN - (n * 6u - 1u)) / 2u : 0u;
    for (uint32_t i = 0; i < n; i++)
    {
        const uint8_t *z = font5x7[zeichen_index(text[i])];
        for (uint32_t s = 0; s < 5u; s++) spalten[x++] = spiegeln(z[s]);
        x++;
    }
    muster[0] = 0xFF;                                         /* Balken links */
    muster[1] = 0x00;
    for (uint32_t k = 0; k < SPALTEN; k++) muster[2u + k] = spalten[k];
    muster[2u + SPALTEN] = 0x00;
    muster[3u + SPALTEN] = 0xFF;                              /* Balken rechts */
    muster[4u + SPALTEN] = 0x00;
}

/* Ein Schwung links -> rechts: Ereignisse zu ihren Zeiten ausgeben (Abfrage der Zeitbasis) */
static void schwung_zeichnen(uint32_t start, uint32_t halbePeriode)
{
    for (uint32_t i = 0; i < EREIGNISSE; i++)
    {
        uint32_t ziel = (uint32_t)(((uint64_t)halbePeriode * ereignisZeit_q16[i]) >> 16);
        while (vergangen(start) < ziel)
        {
            if (!rl()) {                                      /* schon rechts angekommen */
                GPIO_DATA(GPIOM_BASE) = 0;
                return;
            }
        }
        GPIO_DATA(GPIOM_BASE) = muster[i];
    }
    GPIO_DATA(GPIOM_BASE) = 0;
}

/* ---------------------------------------------------------------------------------------------
 * HC-SR04: Trigger-Puls, dann Echo-Dauer messen. Liefert den Abstand in cm oder -1, wenn kein
 * Echo kam (außerhalb von 3..300 cm hält das Modul Echo 200 ms auf HIGH).
 * Schall: 343 m/s -> 58,3 us pro cm (hin und zurück).
 * ------------------------------------------------------------------------------------------- */
#define ECHO_START_MAX_US   2000u              /* Echo muss ca. 450 us nach dem Trigger kommen */
#define ECHO_MAX_US         18000u             /* 300 cm = 17,5 ms */

static int32_t abstand_messen(void)
{
    if (GPIO_DATA_M(GPIOD_BASE, US_ECHO))
    {
        return -1;                             /* letzte Messung (ohne Echo) läuft noch */
    }
    GPIO_DATA_M(GPIOD_BASE, US_TRIGGER) = US_TRIGGER;
    warte_takte(12u * TAKTE_PRO_US);           /* Trigger mindestens 10 us HIGH */
    GPIO_DATA_M(GPIOD_BASE, US_TRIGGER) = 0;   /* fallende Flanke startet die Messung */

    uint32_t t = jetzt();
    while (!GPIO_DATA_M(GPIOD_BASE, US_ECHO))
    {
        if (vergangen(t) > ECHO_START_MAX_US * TAKTE_PRO_US) return -1;
    }
    uint32_t anfang = jetzt();
    while (GPIO_DATA_M(GPIOD_BASE, US_ECHO))
    {
        if (vergangen(anfang) > ECHO_MAX_US * TAKTE_PRO_US) return -1;
    }
    uint32_t us = vergangen(anfang) / TAKTE_PRO_US;
    return (int32_t)((us * 10u + 291u) / 583u);
}

static void init(void)
{
    SYSCTL_RCGCGPIO |= PORT_D | PORT_L | PORT_M;
    SYSCTL_RCGCTIMER |= TIMER_2;
    while ((SYSCTL_PRGPIO & (PORT_D | PORT_L | PORT_M)) != (PORT_D | PORT_L | PORT_M)) {}
    while ((SYSCTL_PRTIMER & TIMER_2) == 0) {}

    GPIO_DIR(GPIOM_BASE) |= PENDEL_LEDS;       /* LEDs: Ausgang */
    GPIO_DEN(GPIOM_BASE) |= PENDEL_LEDS;
    GPIO_DATA(GPIOM_BASE) = 0;
    GPIO_DIR(GPIOL_BASE) &= ~PENDEL_RL;        /* R/L: Eingang (vom Pendel getrieben) */
    GPIO_DEN(GPIOL_BASE) |= PENDEL_RL;
    GPIO_DATA_M(GPIOD_BASE, US_TRIGGER) = 0;
    GPIO_DIR(GPIOD_BASE) = (GPIO_DIR(GPIOD_BASE) | US_TRIGGER) & ~US_ECHO;
    GPIO_DEN(GPIOD_BASE) |= US_TRIGGER | US_ECHO;

    /* Timer2A: 32 Bit, periodisch, freilaufend von 0xFFFFFFFF abwärts */
    TIMER_CTL(TIMER2_BASE) = 0;
    TIMER_CFG(TIMER2_BASE) = 0x0;
    TIMER_TAMR(TIMER2_BASE) = 0x2u;
    TIMER_TAILR(TIMER2_BASE) = 0xFFFFFFFFu;
    TIMER_CTL(TIMER2_BASE) = 1u;
}

int main(void)
{
    init();
    printf("Lab 2: LED-Pendel an PM0..PM7 / PL0, HC-SR04 an PD0 (Trigger) / PD1 (Echo)\n");
    bild_setzen("");

    uint32_t halbePeriode = 0;                 /* gemessene Dauer links -> rechts in Takten */
    int32_t angezeigt = -2;
    char text[12];

    while (1)
    {
        /* Linker Umkehrpunkt = steigende Flanke von R/L (ständiges Abfragen, Aufgabe 1) */
        while (rl()) {}
        while (!rl()) {}
        uint32_t links = jetzt();

        if (halbePeriode)
        {
            schwung_zeichnen(links, halbePeriode);
        }

        /* Rechter Umkehrpunkt = fallende Flanke */
        while (rl()) {}
        uint32_t th = vergangen(links);
        if (th > SYSTEM_CLOCK_HZ / 100u && th < SYSTEM_CLOCK_HZ)     /* 10 ms .. 1 s */
        {
            halbePeriode = th;
        }

        /* Schwung rechts -> links: messen (Aufgabe 2) */
        int32_t cm = abstand_messen();
        if (cm != angezeigt)
        {
            angezeigt = cm;
            if (cm < 0)
            {
                printf("Abstand: kein Echo (ausserhalb 3..300 cm)\n");     /* 2.b */
                bild_setzen("---");
            }
            else
            {
                printf("Abstand: %ld cm\n", (long)cm);                     /* 2.b */
                snprintf(text, sizeof text, "%ldcm", (long)cm);
                bild_setzen(text);                                          /* 3.b */
            }
        }
    }
}
