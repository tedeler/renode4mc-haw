#include "zeitbasis.h"

void zeitbasis_init(void)
{
    SYSCTL_RCGCTIMER |= TIMER_1;
    while ((SYSCTL_PRTIMER & TIMER_1) == 0) {}
    TIMER_CTL(TIMER1_BASE) = 0;                       /* erst aus, dann konfigurieren */
    TIMER_CFG(TIMER1_BASE) = TIMER_CFG_32BIT;
    TIMER_TAMR(TIMER1_BASE) = TIMER_TAMR_PERIODIC;
    TIMER_TAILR(TIMER1_BASE) = 0xFFFFFFFFu;
    TIMER_CTL(TIMER1_BASE) = TIMER_CTL_TAEN;
}
