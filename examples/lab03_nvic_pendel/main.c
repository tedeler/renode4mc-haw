/*
 * Lab 03 - NVIC: LED-Pendel und Ultraschall HC-SR04 mit Interrupts (Lab "Nested Vectored
 * Interrupt Controller" des Mikrocontroller-Praktikums)
 * Board: EK-TM4C1294XL (TM4C1294NCPDT), Takt: 16 MHz (Reset-Takt)
 *
 * Läuft im Simulator (Web-Konsole, Versuch "lab3_nvic") und auf dem Board mit LED-Pendel und
 * HC-SR04 (Bild 3.1 im Skript). Gleiche Aufgabe wie lab02_led_pendel, aber ohne aktives Warten:
 *
 *   Datei                    Inhalt
 *   ------------------------ ---------------------------------------------------------------
 *   ultrasonic_hcsr04.h/.c   HC-SR04 an PD0/PD1: Timer2A (periodisch) triggert, Port-D-ISR misst
 *   pendulum_haw.h/.c        LED-Pendel an PM0..PM7/PL0: Port-L-ISR, Timer0A (16 Bit One-Shot)
 *   zeitbasis.h/.c           Timer1A freilaufend als gemeinsame Zeitbasis (nur lesen)
 *   board.h                  Takt, NVIC-Nummern; Register aus tm4c1294ncpdt.h (common/)
 *
 *   Timer   Betriebsart                    Aufgabe
 *   Timer0A 16 Bit One-Shot, Prescaler 16  Zeitpunkt der nächsten Bildspalte (einziger One-Shot)
 *   Timer1A 32 Bit periodisch, frei        Zeitbasis für Echo-Dauer und Schwungdauer
 *   Timer2A 32 Bit periodisch, 30 ms       Trigger des HC-SR04 (Anf. 1.3)
 *
 * Anf. 3.3: Das Hauptprogramm hat genau eine Endlosschleife. Sie schläft (WFI), bis ein
 * Interrupt kommt, und gibt neue Messwerte mit printf() aus bzw. aufs Pendel.
 */
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include "zeitbasis.h"
#include "ultrasonic_hcsr04.h"
#include "pendulum_haw.h"

int main(void)
{
    zeitbasis_init();
    pendulum_init();
    ultrasonic_init();
    printf("Lab 3 (NVIC): Pendel PM0..PM7/PL0, HC-SR04 PD0/PD1, alles per Interrupt\n");

    int32_t gezeigt = -2;      /* auf dem Pendel */
    int32_t gemeldet = -2;     /* in der Konsole */
    while (1)
    {
        bool neu;
        int32_t cm = getDistance(&neu);
        if (neu && cm != gemeldet)
        {
            gemeldet = cm;
            if (cm == US_KEIN_OBJEKT) printf("Abstand: kein Objekt in Reichweite\n");
            else printf("Abstand: %ld cm\n", (long)cm);
        }
        if (cm != gezeigt && updateDisplay(cm, "cm"))
        {
            gezeigt = cm;
        }
        __asm volatile ("wfi");    /* schlafen bis zum nächsten Interrupt */
    }
}
