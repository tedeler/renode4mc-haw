/*
 * Example 05 - Timer mit CCP-Pins: PWM und Puls im Compare-Mode, Tastendauer im Capture-Mode
 * Board: EK-TM4C1294XL (TM4C1294NCPDT), Takt: 16 MHz (Reset-Takt, wird hier nicht verändert)
 * Versuch in der Web-Konsole: "example3"
 *
 *   Baustein     Pin  Funktion                 Verwendung im Programm
 *   ------------ ---- ------------------------ -----------------------------------------------------
 *   LED1         PL4  T0CCP0 (GPIOPCTL = 3)    PWM ca. 30 Hz, Tastgrad 0/25/50/100 % (Timer0A)
 *   LED2         PL6  T1CCP0 (GPIOPCTL = 3)    Puls 100 ms HIGH alle 1 s (Timer1A)
 *   LED3, LED4   PL0, PL1  GPIO-Ausgang        gewählte Stufe binär (00 = 0 %, 01 = 25 %, 10 = 50 %, 11 = 100 %)
 *   Taste 0      PM0  T2CCP0 (GPIOPCTL = 3)    0 %; Timer2A misst, wie lange sie gedrückt ist (Capture)
 *   Taste 1..3   PM1..PM3  GPIO-Eingang        25 %, 50 %, 100 % (GPIO-Interrupt, fallende Flanke)
 *   UART0        PA0/PA1   U0RX/U0TX           115200 Bit/s 8N1: Stufe und gemessene Tastendauer
 *   Taster gegen GND, interne Pull-ups (GPIOPUR): gedrückt = LOW.
 *
 * Timer0 und Timer1: 16-Bit-Modus (GPTMCFG = 0x4), periodisch abwärts, "Timer Compare Action Mode"
 * (Datenblatt 13.3.3.1, Feld TCACT in GPTMTnMR): Beim Time-out setzt bzw. löscht die Hardware den
 * CCP-Pin – der Pegelwechsel kommt genau zum richtigen Takt, auch wenn die CPU gerade etwas anderes
 * tut. Die Interrupt-Routine plant immer die übernächste Phase:
 *
 *     Phase n           | Phase n+1          | Phase n+2
 *     ------------------+--------------------+-------------------
 *                       ^ Time-out: Pin = Aktion aus TCACT, Zähler lädt TnILR (geschrieben in Phase n)
 *                         ISR: TCACT  = Pegel von Phase n+2 (wirkt beim nächsten Time-out)
 *                              TnILR  = Dauer von Phase n+2 (TnILD = 1: wird erst beim nächsten
 *                                       Time-out geladen, die laufende Phase bleibt ungestört)
 *
 *   Timer0A: Prescaler 16 -> 1 Takt = 1 us, Periode 33 333 us (30 Hz). Bei 30 Hz flimmert eine LED
 *            nur noch leicht, das Auge sieht sie gedimmt.
 *   Timer1A: Prescaler 256 -> 1 Takt = 16 us, Periode 62 500 Takte = 1 s, davon 6 250 = 100 ms HIGH.
 *   (Im 16-Bit-Modus abwärts ist der Prescaler ein echter Vorteiler: Periode = (TnILR+1)*(TnPR+1).)
 *
 * Timer2: Timer A im "Input Edge-Time Mode" (13.3.3.4) an T2CCP0 = PM0 (Taste 0), beide Flanken.
 *   Bei jeder Flanke speichert die Hardware den Zählerstand in GPTMTAR und meldet CAERIS. 16 Bit
 *   plus Prescaler als Erweiterung = 24-Bit-Zähler, abwärts von 0xFF.FFFF, läuft nach 2^24 Takten
 *   = 1,048576 s über. Für längere Tastendrücke zählt Timer B (periodisch, gleiche Periode
 *   (0xFFFF+1)*(0xFF+1) = 2^24 Takte, im selben Takt gestartet) die Überläufe mit – so empfiehlt es
 *   die Anmerkung zu Bild 13-3 im Datenblatt. Timer2B hat dafür eine höhere Priorität als Timer2A.
 *   Auflösung 62,5 ns (1 Takt), Messbereich bis 268 s.
 *
 * Registernamen und Bitkonstanten: TI-Headerdatei tm4c1294ncpdt.h (common/), keine eigenen Adressen.
 */
#include <stdint.h>
#include <stdbool.h>
#include "tm4c1294ncpdt.h"

/* ---------------------------------------------------------------------------------------------
 * Konstanten, die die Headerdatei nicht kennt
 * ------------------------------------------------------------------------------------------- */
#define SYSTEM_CLOCK_HZ     16000000u            /* Reset-Takt PIOSC */
#define TAKTE_PRO_US        (SYSTEM_CLOCK_HZ / 1000000u)

/* GPIOPCTL: je 4 Bit pro Pin (Datenblatt Tabelle 10-2) */
#define PCTL_MASKE(pin)     (0xFu << (4u * (pin)))
#define PCTL_FUNKTION(pin, f) ((uint32_t)(f) << (4u * (pin)))
#define PCTL_UART0          1u                   /* PA0 = U0RX, PA1 = U0TX */
#define PCTL_CCP            3u                   /* PL4 = T0CCP0, PL6 = T1CCP0, PM0 = T2CCP0 */

/* NVIC: Nummer in der Vektortabelle (INT_...) minus 16 */
#define IRQ_TIMER0A         (INT_TIMER0A - 16u)  /* 19 */
#define IRQ_TIMER1A         (INT_TIMER1A - 16u)  /* 21 */
#define IRQ_TIMER2A         (INT_TIMER2A - 16u)  /* 23 */
#define IRQ_TIMER2B         (INT_TIMER2B - 16u)  /* 24 */
#define IRQ_GPIOM           (INT_GPIOM - 16u)    /* 72 -> EN2 Bit 8 */

/* Pins */
#define LED1                (1u << 4)            /* PL4 = T0CCP0 */
#define LED2                (1u << 6)            /* PL6 = T1CCP0 */
#define LED3                (1u << 0)            /* PL0 */
#define LED4                (1u << 1)            /* PL1 */
#define TASTE0              (1u << 0)            /* PM0 = T2CCP0 */
#define TASTE1              (1u << 1)            /* PM1 */
#define TASTE2              (1u << 2)            /* PM2 */
#define TASTE3              (1u << 3)            /* PM3 */
#define TASTEN_GPIO         (TASTE1 | TASTE2 | TASTE3)
#define PINS_UART0          0x03u                /* PA0, PA1 */

/* Timer0A: PWM ("Dimmen" von LED1) */
#define DIMM_PRESCALER       (TAKTE_PRO_US - 1u)  /* 16 Takte = 1 us */
#define DIMM_PERIODE_US      33333u               /* 30 Hz */

/* Timer1A: Puls */
#define PULS_PRESCALER      255u                 /* 256 Takte = 16 us */
#define PULS_TAKT_US        16u
#define PULS_PERIODE        (1000000u / PULS_TAKT_US)   /* 1 s   = 62 500 */
#define PULS_HIGH           (100000u / PULS_TAKT_US)    /* 100 ms =  6 250 */

/* Timer2: 24-Bit-Zähler (TnPR:TnILR) */
#define ZAEHLER_24          0x00FFFFFFu
#define PERIODE_24          (ZAEHLER_24 + 1u)    /* 2^24 Takte */

/* ---------------------------------------------------------------------------------------------
 * Compare-Mode: ein Pin, gesteuert über TCACT und TnILR (siehe Kopfkommentar)
 * ------------------------------------------------------------------------------------------- */
typedef struct
{
    volatile uint32_t *mr;          /* GPTMTAMR des Timers  */
    volatile uint32_t *ilr;         /* GPTMTAILR des Timers */
    uint32_t periode;               /* Takte einer Periode (nach dem Prescaler) */
    volatile uint32_t high;         /* davon HIGH: 0 = immer LOW, >= periode = immer HIGH */
    bool pegel;                     /* Pegel der Phase, die gerade läuft */
} CompareKanal;

static CompareKanal pwm  = { &TIMER0_TAMR_R, &TIMER0_TAILR_R, DIMM_PERIODE_US, 0u, false };
static CompareKanal puls = { &TIMER1_TAMR_R, &TIMER1_TAILR_R, PULS_PERIODE, PULS_HIGH, false };

/* In der ISR (eben ist Phase n+1 angelaufen): Pegel und Dauer von Phase n+2 festlegen */
static void naechste_phase(CompareKanal *k)
{
    bool pegel;
    uint32_t dauer;
    uint32_t high = k->high;

    if (high == 0u)                 /* 0 %: immer LOW */
    {
        pegel = false;
        dauer = k->periode;
    }
    else if (high >= k->periode)    /* 100 %: immer HIGH */
    {
        pegel = true;
        dauer = k->periode;
    }
    else                            /* abwechselnd HIGH und LOW */
    {
        pegel = !k->pegel;
        dauer = pegel ? high : k->periode - high;
    }
    /* TCACT darf sich bei laufendem Timer ändern (Datenblatt GPTMTnMR) */
    *k->mr = (*k->mr & ~TIMER_TAMR_TCACT_M) | (pegel ? TIMER_TAMR_TCACT_SETTO : TIMER_TAMR_TCACT_CLRTO);
    *k->ilr = dauer - 1u;           /* abwärts: TnILR+1 Takte */
    k->pegel = pegel;               /* läuft ab dem nächsten Time-out */
}

void TIMER0A_Handler(void)
{
    TIMER0_ICR_R = TIMER_ICR_TATOCINT;
    naechste_phase(&pwm);
}

void TIMER1A_Handler(void)
{
    TIMER1_ICR_R = TIMER_ICR_TATOCINT;
    naechste_phase(&puls);
}

/* ---------------------------------------------------------------------------------------------
 * Stufe (Tastgrad der PWM): Taste 0..3 -> 0, 25, 50, 100 %
 * ------------------------------------------------------------------------------------------- */
static const uint8_t PROZENT[4] = { 0u, 25u, 50u, 100u };
static volatile uint32_t stufe;
static volatile bool stufe_neu;

static void stufe_setzen(uint32_t s)
{
    pwm.high = DIMM_PERIODE_US * PROZENT[s] / 100u;
    stufe = s;
    stufe_neu = true;
    /* LED3 = Bit 0, LED4 = Bit 1 der Stufe */
    GPIO_PORTL_DATA_BITS_R[LED3 | LED4] = ((s & 1u) ? LED3 : 0u) | ((s & 2u) ? LED4 : 0u);
}

/* Taste 1..3: GPIO-Interrupt bei fallender Flanke (Drücken) */
void GPIOM_Handler(void)
{
    uint32_t flanken = GPIO_PORTM_MIS_R & TASTEN_GPIO;
    GPIO_PORTM_ICR_R = flanken;
    if (flanken & TASTE3) stufe_setzen(3u);
    else if (flanken & TASTE2) stufe_setzen(2u);
    else if (flanken & TASTE1) stufe_setzen(1u);
}

/* ---------------------------------------------------------------------------------------------
 * Timer2: Dauer von Taste 0 (Capture)
 * ------------------------------------------------------------------------------------------- */
static volatile uint32_t ueberlaeufe;   /* Überläufe des 24-Bit-Zählers (Timer2B) */
static uint32_t druck_beginn;           /* Zeitstempel in Takten (modulo 2^32) */
static bool gedrueckt;
static volatile uint32_t dauer_takte;
static volatile bool dauer_neu;

/* Timer2B: Time-out alle 2^24 Takte = Überlauf von Timer2A */
void TIMER2B_Handler(void)
{
    TIMER2_ICR_R = TIMER_ICR_TBTOCINT;
    ueberlaeufe++;
}

/* Zeitstempel einer Flanke in Takten seit dem Start: Überläufe * 2^24 + abgelaufene Takte.
 * Der Überlauf kann kurz vor oder nach der Flanke kommen; deshalb mit gesperrten Interrupts
 * nachsehen, ob der Zähler seit der Flanke übergelaufen ist und ob Timer2B noch wartet. */
static uint32_t zeitstempel(uint32_t erfasst)
{
    uint32_t vorher, jetzt, n;
    bool wartet;

    __asm volatile("cpsid i");
    do
    {
        vorher = TIMER2_TAV_R & ZAEHLER_24;
        wartet = (TIMER2_RIS_R & TIMER_RIS_TBTORIS) != 0;   /* Überlauf, ISR noch nicht gelaufen */
        jetzt = TIMER2_TAV_R & ZAEHLER_24;
    } while (jetzt > vorher);                                /* dazwischen übergelaufen: nochmal */
    n = ueberlaeufe + (wartet ? 1u : 0u);
    __asm volatile("cpsie i");

    if (jetzt > erfasst) n--;       /* abwärts: größer = seit der Flanke übergelaufen */
    return n * PERIODE_24 + (ZAEHLER_24 - erfasst);
}

/* Timer2A: Flanke an Taste 0 (beide Flanken) */
void TIMER2A_Handler(void)
{
    TIMER2_ICR_R = TIMER_ICR_CAECINT;
    uint32_t t = zeitstempel(TIMER2_TAR_R & ZAEHLER_24);

    if ((GPIO_PORTM_DATA_BITS_R[TASTE0]) == 0u)   /* LOW = gedrückt: fallende Flanke */
    {
        druck_beginn = t;
        gedrueckt = true;
        stufe_setzen(0u);
    }
    else if (gedrueckt)                           /* losgelassen: steigende Flanke */
    {
        dauer_takte = t - druck_beginn;
        gedrueckt = false;
        dauer_neu = true;
    }
}

/* ---------------------------------------------------------------------------------------------
 * UART0: Ausgabe (Abfrage, nur aus dem Hauptprogramm)
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

/* Zahl dezimal, mindestens 'stellen' Ziffern (mit führenden Nullen) */
static void uart_zahl(uint32_t wert, uint32_t stellen)
{
    char puffer[10];
    uint32_t n = 0;
    do
    {
        puffer[n++] = (char)('0' + wert % 10u);
        wert /= 10u;
    } while (wert != 0u || n < stellen);
    while (n > 0u) uart_putc(puffer[--n]);
}

/* ---------------------------------------------------------------------------------------------
 * Konfiguration
 * ------------------------------------------------------------------------------------------- */
static void config_takte(void)
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
    GPIO_PORTA_AHB_PCTL_R = (GPIO_PORTA_AHB_PCTL_R & ~(PCTL_MASKE(0) | PCTL_MASKE(1)))
                          | PCTL_FUNKTION(0, PCTL_UART0) | PCTL_FUNKTION(1, PCTL_UART0);
    UART0_CTL_R &= ~UART_CTL_UARTEN;
    UART0_IBRD_R = 8;                              /* 16 MHz / (16 * 115200) = 8,6806 */
    UART0_FBRD_R = 44;                             /* 0,6806 * 64 = 43,6 -> 44 */
    UART0_LCRH_R = UART_LCRH_WLEN_8 | UART_LCRH_FEN;   /* 8N1, FIFO */
    UART0_CTL_R |= UART_CTL_TXE | UART_CTL_RXE | UART_CTL_UARTEN;
}

static void config_pins(void)
{
    /* Port L: PL4/PL6 = CCP-Ausgänge der Timer, PL0/PL1 = GPIO-Ausgänge */
    GPIO_PORTL_DIR_R |= LED3 | LED4;
    GPIO_PORTL_AFSEL_R |= LED1 | LED2;
    GPIO_PORTL_PCTL_R = (GPIO_PORTL_PCTL_R & ~(PCTL_MASKE(4) | PCTL_MASKE(6)))
                      | PCTL_FUNKTION(4, PCTL_CCP) | PCTL_FUNKTION(6, PCTL_CCP);
    GPIO_PORTL_DEN_R |= LED1 | LED2 | LED3 | LED4;

    /* Port M: PM0 = T2CCP0 (Eingang des Timers), PM1..PM3 = GPIO-Eingänge; alle mit Pull-up */
    GPIO_PORTM_DIR_R &= ~(TASTE0 | TASTEN_GPIO);
    GPIO_PORTM_PUR_R |= TASTE0 | TASTEN_GPIO;
    GPIO_PORTM_AFSEL_R |= TASTE0;
    GPIO_PORTM_PCTL_R = (GPIO_PORTM_PCTL_R & ~PCTL_MASKE(0)) | PCTL_FUNKTION(0, PCTL_CCP);
    GPIO_PORTM_DEN_R |= TASTE0 | TASTEN_GPIO;

    /* Taste 1..3: Interrupt bei fallender Flanke */
    GPIO_PORTM_IM_R &= ~TASTEN_GPIO;
    GPIO_PORTM_IS_R &= ~TASTEN_GPIO;
    GPIO_PORTM_IBE_R &= ~TASTEN_GPIO;
    GPIO_PORTM_IEV_R &= ~TASTEN_GPIO;
    GPIO_PORTM_ICR_R = TASTEN_GPIO;
    GPIO_PORTM_IM_R |= TASTEN_GPIO;
}

/* Timer A eines Timers im 16-Bit-Compare-Mode starten: beide ersten Phasen LOW */
static void config_compare(volatile uint32_t *ctl, volatile uint32_t *cfg, volatile uint32_t *pr,
                           volatile uint32_t *imr, CompareKanal *k, uint32_t prescaler)
{
    *ctl = 0u;                                     /* Timer aus, bevor er konfiguriert wird */
    *cfg = TIMER_CFG_16_BIT;
    *k->mr = TIMER_TAMR_TAMR_PERIOD                /* periodisch, abwärts (TACDIR = 0) */
           | TIMER_TAMR_TAILD                      /* neues TAILR erst beim nächsten Time-out */
           | TIMER_TAMR_TCACT_CLRTO;               /* Ende Phase 0: Pin LOW */
    *pr = prescaler;
    *k->ilr = k->periode - 1u;                     /* Phase 0 (wird beim Einschalten geladen) */
    *imr = TIMER_IMR_TATOIM;
    *ctl = TIMER_CTL_TAEN;
    *k->ilr = k->periode - 1u;                     /* Phase 1 (TAILD: gilt ab dem 1. Time-out) */
    k->pegel = false;                              /* Phase 1 ist LOW, die ISR plant ab Phase 2 */
}

static void config_capture(void)
{
    TIMER2_CTL_R = 0u;
    TIMER2_CFG_R = TIMER_CFG_16_BIT;
    TIMER2_TAMR_R = TIMER_TAMR_TAMR_CAP | TIMER_TAMR_TACMR;   /* Edge-Time, abwärts */
    TIMER2_TBMR_R = TIMER_TBMR_TBMR_PERIOD;                   /* Überlaufzähler, abwärts */
    TIMER2_TAPR_R = 0xFFu;                                    /* 24 Bit: 0xFF:FFFF */
    TIMER2_TAILR_R = 0xFFFFu;
    TIMER2_TBPR_R = 0xFFu;                                    /* (0xFF+1) * (0xFFFF+1) = 2^24 */
    TIMER2_TBILR_R = 0xFFFFu;
    TIMER2_ICR_R = TIMER_ICR_CAECINT | TIMER_ICR_TBTOCINT;
    TIMER2_IMR_R = TIMER_IMR_CAEIM | TIMER_IMR_TBTOIM;
    /* beide Hälften mit einem Schreibzugriff starten: gleicher Takt, gleiche Überläufe */
    TIMER2_CTL_R = TIMER_CTL_TAEVENT_BOTH | TIMER_CTL_TAEN | TIMER_CTL_TBEN;
}

static void config_nvic(void)
{
    /* Priorität (0 = höchste, Bits 7:5): Timer2B 0, Timer2A 1, Rest 2 */
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
    config_takte();
    config_uart0();
    config_pins();
    stufe_setzen(1u);                              /* Start mit 25 % */
    config_nvic();
    config_compare(&TIMER0_CTL_R, &TIMER0_CFG_R, &TIMER0_TAPR_R, &TIMER0_IMR_R, &pwm, DIMM_PRESCALER);
    config_compare(&TIMER1_CTL_R, &TIMER1_CFG_R, &TIMER1_TAPR_R, &TIMER1_IMR_R, &puls, PULS_PRESCALER);
    config_capture();
    __asm volatile("cpsie i");

    uart_puts("\r\nExample 05 Timer-CCP: LED1 = PWM 30 Hz (Timer0), LED2 = Puls 100 ms/1 s (Timer1)\r\n");
    uart_puts("Taste 0..3 = 0/25/50/100 %, Timer2 misst die Dauer von Taste 0\r\n");

    while (1)
    {
        __asm volatile("wfi");                     /* schlafen bis zum nächsten Interrupt */
        if (stufe_neu)
        {
            stufe_neu = false;
            uart_puts("PWM: ");
            uart_zahl(PROZENT[stufe], 1u);
            uart_puts(" %\r\n");
        }
        if (dauer_neu)
        {
            dauer_neu = false;
            uint32_t us = dauer_takte / TAKTE_PRO_US;
            uart_puts("Taste 0 gedrueckt: ");
            uart_zahl(us / 1000u, 1u);
            uart_putc(',');
            uart_zahl(us % 1000u, 3u);
            uart_puts(" ms\r\n");
        }
    }
}
