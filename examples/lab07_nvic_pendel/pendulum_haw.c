#include "pendulum_haw.h"
#include "register.h"
#include "zeitbasis.h"

#define PENDEL_LEDS         0xFFu              /* PM0..PM7 */
#define PENDEL_RL           (1u << 0)          /* PL0 */
#define PRESCALER           (TAKTE_PRO_US - 1u)/* Timer0A: 16 Takte = 1 us pro Zählschritt */

/*
 * Zeitpunkte, an denen sich die LEDs ändern, als Anteil t/Th des Schwungs links -> rechts
 * (Einheit 1/65536). Die Auslenkung ist x(t) = -cos(pi * t / Th), eine Stelle x wird also bei
 * t = Th * acos(-x) / pi überstrichen. Ereignisse: Balken links an/aus, 40 Textspalten
 * (x = -0,8 .. +0,8) und deren Ende, Balken rechts an/aus. (Wie lab06_led_pendel.)
 */
#define SPALTEN             40u
#define EREIGNISSE          (2u + SPALTEN + 1u + 2u)

static const uint16_t ereignisZeit_q16[EREIGNISSE] = {
     3618,  7263,
    12694, 14122, 15437, 16667, 17831, 18940, 20005, 21033, 22030, 23001,
    23949, 24879, 25792, 26692, 27580, 28458, 29329, 30194, 31054, 31912,
    32768, 33624, 34482, 35342, 36207, 37078, 37956, 38844, 39744, 40657,
    41587, 42535, 43506, 44503, 45531, 46596, 47705, 48869, 50099, 51414,
    52842,
    58273, 61918,
};

/* Doppelpuffer: Die ISR zeigt "aktiv", das Hauptprogramm füllt "neu" */
static uint8_t puffer[2][EREIGNISSE];
static volatile uint8_t *aktiv = puffer[0];
static volatile bool     neuBereit;

/* Zustand des Bildaufbaus (nur in den ISRs) */
static uint32_t schwungStart;                  /* Zeitbasis beim linken Umkehrpunkt */
static volatile uint32_t halbePeriode;         /* Dauer links -> rechts in Takten (0 = unbekannt) */
static uint32_t ereignis;                      /* nächstes Ereignis */
static bool     zeichnet;

static uint32_t zielTakte(uint32_t i)
{
    return (uint32_t)(((uint64_t)halbePeriode * ereignisZeit_q16[i]) >> 16);
}

/* Einmal-Timer auf das nächste Ereignis stellen (höchstens 65,5 ms, sonst in Etappen) */
static void timer_stellen(void)
{
    uint32_t ziel = zielTakte(ereignis);
    uint32_t vorbei = zeitbasis_seit(schwungStart);
    uint32_t us = ziel > vorbei ? (ziel - vorbei) / TAKTE_PRO_US : 0u;
    if (us < 1u) us = 1u;
    if (us > 0x10000u) us = 0x10000u;
    TIMER_TAILR(TIMER0_BASE) = us - 1u;
    TIMER_CTL(TIMER0_BASE) = TIMER_CTL_TAEN;   /* One-Shot: lädt TAILR/TAPR und startet */
}

/* Timer0A (16 Bit, One-Shot): alle fälligen Ereignisse ausgeben, dann das nächste planen */
void TIMER0A_Handler(void)
{
    TIMER_ICR(TIMER0_BASE) = TIMER_ICR_TATOCINT;
    if (!zeichnet) return;
    uint32_t vorbei = zeitbasis_seit(schwungStart);
    while (ereignis < EREIGNISSE && vorbei + TAKTE_PRO_US / 2u >= zielTakte(ereignis))
    {
        GPIO_DATA(GPIOM_BASE) = aktiv[ereignis];
        ereignis++;
    }
    if (ereignis < EREIGNISSE)
    {
        timer_stellen();
    }
    else
    {
        zeichnet = false;
        GPIO_DATA(GPIOM_BASE) = 0;
    }
}

/* Port L: Umkehrpunkt (Interrupt an beiden Flanken von R/L) */
void GPIOL_Handler(void)
{
    uint32_t jetzt = zeitbasis_jetzt();
    GPIO_ICR(GPIOL_BASE) = PENDEL_RL;
    if (GPIO_DATA_M(GPIOL_BASE, PENDEL_RL))
    {
        /* linker Umkehrpunkt: Schwung links -> rechts beginnt, Bild ausgeben */
        schwungStart = jetzt;
        if (neuBereit)
        {
            aktiv = (aktiv == puffer[0]) ? puffer[1] : puffer[0];
            neuBereit = false;
        }
        if (halbePeriode)
        {
            ereignis = 0;
            zeichnet = true;
            timer_stellen();
        }
    }
    else
    {
        /* rechter Umkehrpunkt: Schwungdauer messen, LEDs aus */
        uint32_t th = schwungStart - jetzt;
        if (th > SYSTEM_CLOCK_HZ / 100u && th < SYSTEM_CLOCK_HZ)        /* 10 ms .. 1 s */
        {
            halbePeriode = th;
        }
        zeichnet = false;
        TIMER_CTL(TIMER0_BASE) = 0;
        GPIO_DATA(GPIOM_BASE) = 0;
    }
}

/* 5x7-Zeichensatz, Spalten, Bit 0 = oberste Zeile */
static const uint8_t font5x7[][5] = {
    { 0x3E, 0x51, 0x49, 0x45, 0x3E }, { 0x00, 0x42, 0x7F, 0x40, 0x00 },   /* 0 1 */
    { 0x42, 0x61, 0x51, 0x49, 0x46 }, { 0x21, 0x41, 0x45, 0x4B, 0x31 },   /* 2 3 */
    { 0x18, 0x14, 0x12, 0x7F, 0x10 }, { 0x27, 0x45, 0x45, 0x45, 0x39 },   /* 4 5 */
    { 0x3C, 0x4A, 0x49, 0x49, 0x30 }, { 0x01, 0x71, 0x09, 0x05, 0x03 },   /* 6 7 */
    { 0x36, 0x49, 0x49, 0x49, 0x36 }, { 0x06, 0x49, 0x49, 0x29, 0x1E },   /* 8 9 */
    { 0x38, 0x44, 0x44, 0x44, 0x20 },                                     /* c (10) */
    { 0x7C, 0x04, 0x18, 0x04, 0x78 },                                     /* m (11) */
    { 0x00, 0x00, 0x00, 0x00, 0x00 },                                     /* sonst: leer */
};

static uint32_t zeichen_index(char c)
{
    if (c >= '0' && c <= '9') return (uint32_t)(c - '0');
    if (c == 'c') return 10u;
    if (c == 'm') return 11u;
    return 12u;
}

/* Zeichensatz (Bit 0 oben) -> Port M (LED 7 = PM7 oben) */
static uint8_t spiegeln(uint8_t b)
{
    uint8_t r = 0;
    for (uint32_t i = 0; i < 8u; i++)
    {
        if (b & (1u << i)) r |= (uint8_t)(0x80u >> i);
    }
    return r;
}

bool updateDisplay(int32_t ulDistance, const char *unit)
{
    if (neuBereit) return false;                       /* voriges Bild noch nicht übernommen */
    uint8_t *ziel = (uint8_t *)((aktiv == puffer[0]) ? puffer[1] : puffer[0]);
    char text[8];
    uint32_t n = 0;
    if (ulDistance >= 0)                               /* Anf. 2.3: nur mit Objekt in Reichweite */
    {
        char ziffern[6];
        uint32_t k = 0, v = (uint32_t)ulDistance;
        do { ziffern[k++] = (char)('0' + v % 10u); v /= 10u; } while (v && k < sizeof ziffern);
        while (k) text[n++] = ziffern[--k];
        while (*unit && n < sizeof text) text[n++] = *unit++;
    }
    for (uint32_t i = 0; i < EREIGNISSE; i++) ziel[i] = 0;
    uint32_t x = n ? (SPALTEN - (n * 6u - 1u)) / 2u : 0u;
    for (uint32_t i = 0; i < n; i++)
    {
        const uint8_t *z = font5x7[zeichen_index(text[i])];
        for (uint32_t s = 0; s < 5u; s++) ziel[2u + x++] = spiegeln(z[s]);
        x++;
    }
    ziel[0] = 0xFF;                                    /* Balken am linken ... */
    ziel[3u + SPALTEN] = 0xFF;                         /* ... und rechten Rand */
    neuBereit = true;
    return true;
}

uint32_t pendulum_halbePeriodeUs(void)
{
    return halbePeriode / TAKTE_PRO_US;
}

void pendulum_init(void)
{
    SYSCTL_RCGCGPIO |= PORT_L | PORT_M;
    SYSCTL_RCGCTIMER |= TIMER_0;
    while ((SYSCTL_PRGPIO & (PORT_L | PORT_M)) != (PORT_L | PORT_M)) {}
    while ((SYSCTL_PRTIMER & TIMER_0) == 0) {}

    GPIO_DATA(GPIOM_BASE) = 0;
    GPIO_DIR(GPIOM_BASE) |= PENDEL_LEDS;
    GPIO_DEN(GPIOM_BASE) |= PENDEL_LEDS;

    /* R/L: Eingang, Interrupt an beiden Flanken */
    GPIO_DIR(GPIOL_BASE) &= ~PENDEL_RL;
    GPIO_DEN(GPIOL_BASE) |= PENDEL_RL;
    GPIO_IM(GPIOL_BASE) &= ~PENDEL_RL;
    GPIO_IS(GPIOL_BASE) &= ~PENDEL_RL;
    GPIO_IBE(GPIOL_BASE) |= PENDEL_RL;
    GPIO_ICR(GPIOL_BASE) = PENDEL_RL;
    GPIO_IM(GPIOL_BASE) |= PENDEL_RL;

    /* Timer0A: 16 Bit One-Shot, Prescaler 16 (1 us) – der einzige One-Shot-Timer */
    TIMER_CTL(TIMER0_BASE) = 0;
    TIMER_CFG(TIMER0_BASE) = TIMER_CFG_16BIT;
    TIMER_TAMR(TIMER0_BASE) = TIMER_TAMR_ONESHOT;
    TIMER_TAPR(TIMER0_BASE) = PRESCALER;
    TIMER_TAILR(TIMER0_BASE) = 0xFFFFu;
    TIMER_ICR(TIMER0_BASE) = TIMER_ICR_TATOCINT;
    TIMER_IMR(TIMER0_BASE) = TIMER_IMR_TATOIM;

    nvic_enable(IRQ_TIMER0A);
    nvic_enable(IRQ_GPIOL);
}
