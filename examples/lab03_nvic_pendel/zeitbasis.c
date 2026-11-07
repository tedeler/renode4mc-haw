#include "zeitbasis.h"

void zeitbasis_init(void)
{
    SYSCTL_RCGCTIMER_R |= SYSCTL_RCGCTIMER_R1;
    while ((SYSCTL_PRTIMER_R & SYSCTL_PRTIMER_R1) == 0) {}
    TIMER1_CTL_R = 0;                                 /* erst aus, dann konfigurieren */
    TIMER1_CFG_R = TIMER_CFG_32_BIT_TIMER;
    TIMER1_TAMR_R = TIMER_TAMR_TAMR_PERIOD;
    TIMER1_TAILR_R = 0xFFFFFFFFu;
    TIMER1_CTL_R = TIMER_CTL_TAEN;
}
