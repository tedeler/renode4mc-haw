#include "ultrasonic_hcsr04.h"
#include "register.h"
#include "zeitbasis.h"

#define US_TRIGGER          (1u << 0)          /* PD0 */
#define US_ECHO             (1u << 1)          /* PD1 */
#define ECHO_MAX_US         18000u             /* 300 cm = 17,5 ms; länger = kein Objekt (200 ms) */

static volatile int32_t  abstand = US_KEIN_OBJEKT;
static volatile bool     neuerWert;
static volatile uint32_t echoBeginn;
static volatile bool     echoLaeuft;

/*
 * Timer2A (periodisch, 30 ms): Trigger umschalten. Der Trigger ruht auf HIGH; die FALLENDE
 * Flanke startet eine Messung (Bild 5 im Skript). Er bleibt dann 30 ms LOW und geht wieder
 * auf HIGH – damit ist er vor der nächsten fallenden Flanke 30 ms (>= 10 us) HIGH.
 */
void TIMER2A_Handler(void)
{
    TIMER_ICR(TIMER2_BASE) = TIMER_ICR_TATOCINT;
    uint32_t t = GPIO_DATA_M(GPIOD_BASE, US_TRIGGER);
    GPIO_DATA_M(GPIOD_BASE, US_TRIGGER) = t ^ US_TRIGGER;
}

/* Port D: Flanke am Echo. Steigend = Messung beginnt, fallend = Echo zurück */
void GPIOD_Handler(void)
{
    uint32_t jetzt = zeitbasis_jetzt();
    GPIO_ICR(GPIOD_BASE) = US_ECHO;
    if (GPIO_DATA_M(GPIOD_BASE, US_ECHO))
    {
        echoBeginn = jetzt;
        echoLaeuft = true;
        return;
    }
    if (!echoLaeuft) return;
    echoLaeuft = false;
    uint32_t us = (echoBeginn - jetzt) / TAKTE_PRO_US;
    /* 343 m/s: 58,3 us pro cm (hin und zurück) */
    abstand = us > ECHO_MAX_US ? US_KEIN_OBJEKT : (int32_t)((us * 10u + 291u) / 583u);
    neuerWert = true;
}

void ultrasonic_init(void)
{
    SYSCTL_RCGCGPIO |= PORT_D;
    SYSCTL_RCGCTIMER |= TIMER_2;
    while ((SYSCTL_PRGPIO & PORT_D) == 0) {}
    while ((SYSCTL_PRTIMER & TIMER_2) == 0) {}

    GPIO_DATA_M(GPIOD_BASE, US_TRIGGER) = US_TRIGGER;           /* Ruhepegel HIGH */
    GPIO_DIR(GPIOD_BASE) = (GPIO_DIR(GPIOD_BASE) | US_TRIGGER) & ~US_ECHO;
    GPIO_DEN(GPIOD_BASE) |= US_TRIGGER | US_ECHO;

    /* Echo: Interrupt an beiden Flanken (Datenblatt: erst maskieren, dann einstellen, RIS löschen) */
    GPIO_IM(GPIOD_BASE) &= ~US_ECHO;
    GPIO_IS(GPIOD_BASE) &= ~US_ECHO;                            /* Flanke */
    GPIO_IBE(GPIOD_BASE) |= US_ECHO;                            /* beide Flanken */
    GPIO_ICR(GPIOD_BASE) = US_ECHO;
    GPIO_IM(GPIOD_BASE) |= US_ECHO;
    nvic_enable(IRQ_GPIOD);

    /* Timer2A: 32 Bit periodisch, 30 ms */
    TIMER_CTL(TIMER2_BASE) = 0;
    TIMER_CFG(TIMER2_BASE) = TIMER_CFG_32BIT;
    TIMER_TAMR(TIMER2_BASE) = TIMER_TAMR_PERIODIC;
    TIMER_TAILR(TIMER2_BASE) = US_MESSABSTAND_MS * (SYSTEM_CLOCK_HZ / 1000u) - 1u;
    TIMER_ICR(TIMER2_BASE) = TIMER_ICR_TATOCINT;
    TIMER_IMR(TIMER2_BASE) = TIMER_IMR_TATOIM;
    nvic_enable(IRQ_TIMER2A);
    TIMER_CTL(TIMER2_BASE) = TIMER_CTL_TAEN;
}

int32_t getDistance(bool *neu)
{
    if (neu)
    {
        *neu = neuerWert;
        neuerWert = false;
    }
    return abstand;
}
