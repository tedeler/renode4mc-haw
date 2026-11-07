/*
 * pendulum_haw.h - LED-Pendel "Swinging LED" des HAW-Labors, komplett interruptgesteuert
 *
 *   LEDs PM0..PM7 (LED 7 = PM7 oben), Signal R/L an PL0:
 *   steigende Flanke = linker Umkehrpunkt, fallende Flanke = rechter Umkehrpunkt
 *   Anf. 3.1  kein aktives Warten: Port-L-Interrupt (Umkehrpunkte) und ein 16-Bit-One-Shot-Timer
 *             (Timer0A, Prescaler 16 -> 1 us) für die Zeitpunkte der Bildspalten
 *   Bild nur im Schwung links -> rechts (im anderen Schwung ist Zeit zum Messen)
 */
#ifndef PENDULUM_HAW_H_
#define PENDULUM_HAW_H_

#include <stdint.h>
#include <stdbool.h>

void pendulum_init(void);

/* Abstand mit Einheit anzeigen; Anf. 2.3: ulDistance < 0 (kein Objekt) -> nichts anzeigen.
 * Liefert false, wenn das vorige Bild noch nicht übernommen ist (später erneut aufrufen). */
bool updateDisplay(int32_t ulDistance, const char *unit);

/* Dauer eines Schwungs in us (0 = noch nicht gemessen) */
uint32_t pendulum_halbePeriodeUs(void);

#endif /* PENDULUM_HAW_H_ */
