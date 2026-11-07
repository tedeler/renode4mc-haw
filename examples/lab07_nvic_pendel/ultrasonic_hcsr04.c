#include "ultrasonic_hcsr04.h"
#include "board.h"
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
    TIMER2_ICR_R = TIMER_ICR_TATOCINT;
    uint32_t t = GPIO_PORTD_AHB_DATA_BITS_R[US_TRIGGER];
    GPIO_PORTD_AHB_DATA_BITS_R[US_TRIGGER] = t ^ US_TRIGGER;
}

/* Port D: Flanke am Echo. Steigend = Messung beginnt, fallend = Echo zurück */
void GPIOD_Handler(void)
{
    uint32_t jetzt = zeitbasis_jetzt();
    GPIO_PORTD_AHB_ICR_R = US_ECHO;
    if (GPIO_PORTD_AHB_DATA_BITS_R[US_ECHO])
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
    SYSCTL_RCGCGPIO_R |= SYSCTL_RCGCGPIO_R3;
    SYSCTL_RCGCTIMER_R |= SYSCTL_RCGCTIMER_R2;
    while ((SYSCTL_PRGPIO_R & SYSCTL_PRGPIO_R3) == 0) {}
    while ((SYSCTL_PRTIMER_R & SYSCTL_PRTIMER_R2) == 0) {}

    GPIO_PORTD_AHB_DATA_BITS_R[US_TRIGGER] = US_TRIGGER;        /* Ruhepegel HIGH */
    GPIO_PORTD_AHB_DIR_R = (GPIO_PORTD_AHB_DIR_R | US_TRIGGER) & ~US_ECHO;
    GPIO_PORTD_AHB_DEN_R |= US_TRIGGER | US_ECHO;

    /* Echo: Interrupt an beiden Flanken (Datenblatt: erst maskieren, dann einstellen, RIS löschen) */
    GPIO_PORTD_AHB_IM_R &= ~US_ECHO;
    GPIO_PORTD_AHB_IS_R &= ~US_ECHO;                            /* Flanke */
    GPIO_PORTD_AHB_IBE_R |= US_ECHO;                            /* beide Flanken */
    GPIO_PORTD_AHB_ICR_R = US_ECHO;
    GPIO_PORTD_AHB_IM_R |= US_ECHO;
    nvic_enable(IRQ_GPIOD);

    /* Timer2A: 32 Bit periodisch, 30 ms */
    TIMER2_CTL_R = 0;
    TIMER2_CFG_R = TIMER_CFG_32_BIT_TIMER;
    TIMER2_TAMR_R = TIMER_TAMR_TAMR_PERIOD;
    TIMER2_TAILR_R = US_MESSABSTAND_MS * (SYSTEM_CLOCK_HZ / 1000u) - 1u;
    TIMER2_ICR_R = TIMER_ICR_TATOCINT;
    TIMER2_IMR_R = TIMER_IMR_TATOIM;
    nvic_enable(IRQ_TIMER2A);
    TIMER2_CTL_R = TIMER_CTL_TAEN;
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
