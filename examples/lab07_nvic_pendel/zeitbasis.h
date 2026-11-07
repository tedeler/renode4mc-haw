/*
 * zeitbasis.h - freilaufende Zeitbasis mit Timer1A (32 Bit, periodisch, abwärts, 16 MHz).
 * Wird nur gelesen (kein Interrupt): für Echo-Laufzeit und Schwungdauer des Pendels.
 */
#ifndef ZEITBASIS_H_
#define ZEITBASIS_H_

#include <stdint.h>
#include "board.h"

void zeitbasis_init(void);

/* aktueller Stand (zählt abwärts) */
static inline uint32_t zeitbasis_jetzt(void)
{
    return TIMER1_TAV_R;
}

/* Takte seit "seit" (auch über den Überlauf hinweg richtig) */
static inline uint32_t zeitbasis_seit(uint32_t seit)
{
    return seit - zeitbasis_jetzt();
}

#endif /* ZEITBASIS_H_ */
