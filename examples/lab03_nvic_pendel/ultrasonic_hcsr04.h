/*
 * ultrasonic_hcsr04.h - Ultraschallmodul HC-SR04, komplett interruptgesteuert
 *
 *   Trigger = PD0 (Ausgang), Echo = PD1 (Eingang)
 *   Anf. 1.1  eigener Timer für die Messung: Zeitbasis Timer1A (zeitbasis.h)
 *   Anf. 1.2  Laufzeit des Echos in einer ISR messen: GPIOD_Handler, Interrupt an beiden Flanken
 *   Anf. 1.3  neue Messung aus dem Interrupt eines eigenen, periodischen Timers: Timer2A
 *   Anf. 1.4  kein aktives Warten, kein Abfragen von Flanken
 */
#ifndef ULTRASONIC_HCSR04_H_
#define ULTRASONIC_HCSR04_H_

#include <stdint.h>
#include <stdbool.h>

#define US_KEIN_OBJEKT      (-1)               /* kein Echo: außerhalb 3..300 cm */
#define US_MESSABSTAND_MS   30u                /* Trigger-Flanke alle 2 x 30 ms */

void ultrasonic_init(void);

/* letzter Messwert in cm oder US_KEIN_OBJEKT; *neu = true, wenn seit dem letzten Aufruf gemessen */
int32_t getDistance(bool *neu);

#endif /* ULTRASONIC_HCSR04_H_ */
