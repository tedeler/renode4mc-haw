/*
 * Lab 05 - Hex-Keypad und BCD-Anzeige (MCL Lab Session 1, Teil 2: GPIO)
 * Board: EK-TM4C1294XL (TM4C1294NCPDT), Takt: 16 MHz (Reset-Takt, wird hier nicht verändert)
 *
 * Läuft im Simulator (Web-Konsole, Versuch "lab1_gpio") und auf dem Board mit dem
 * Hex-Keypad und der 7-Segment-Anzeige des HAW-IT-Labors.
 *
 *   Baustein                 Anschluss                          Verwendung im Programm
 *   ------------------------ ---------------------------------- -------------------------------------
 *   Hex-Keypad 4x4           X1..X4 = PM0..PM3 (Ausgang)        Spalten nacheinander auf 0 setzen
 *                            Y1..Y4 = PM4..PM7 (Eingang,        gedrückte Taste: Y = 0 in ihrer Spalte
 *                            Pull-up auf dem Keypad)
 *   BCD-Anzeige 4 Ziffern    D0..D7 = PK0..PK7 (Ausgang)        zwei Ziffern je Modul (8421-BCD)
 *                            EN rechts = PL0, EN links = PL1    EN = 1: Modul übernimmt D0..D7
 *   CCS-Konsole              printf()                           gedrückte Taste, Fehlermeldung
 *
 * Anforderungen aus dem Laborskript:
 *   4.1  Tasten in einer Endlosschleife abfragen und mit printf() ausgeben,
 *        Anf. 1: jede Taste nur EINMAL ausgeben, solange sie gedrückt ist,
 *        Anf. 2: mehrere Tasten gleichzeitig -> Fehlermeldung.
 *   4.2  Die gedrückte Taste zusätzlich auf der 7-Segment-Anzeige zeigen. Hier: rechts die
 *        zuletzt gedrückte Taste, links davon die drei davor (wie bei einer Zahleneingabe).
 *
 * Laufzeitverzögerung: Nach dem Umschalten einer Spalte braucht die Zeilenleitung Zeit, bis der
 * Pull-up sie wieder auf HIGH gezogen hat. Darum wartet keypad_scan() vor jedem Lesen (wait()).
 * Im Simulator ist diese Anstiegszeit nachgebildet (20 us): Ohne wait() erscheinen Tasten auch in
 * der falschen Spalte.
 *
 * Alle Adressen stammen aus dem Datenblatt "TM4C1294NCPDT" (SPMS433).
 */
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>

#define REG(adresse)        (*(volatile uint32_t *)(adresse))

/* ---------------------------------------------------------------------------------------------
 * Register
 * ------------------------------------------------------------------------------------------- */
#define SYSCTL_RCGCGPIO     REG(0x400FE000 + 0x608)
#define SYSCTL_PRGPIO       REG(0x400FE000 + 0xA08)

#define GPIO_DATA_M(base,m) REG((base) + ((m) << 2))       /* nur die Bits in Maske m */
#define GPIO_DIR(base)      REG((base) + 0x400)
#define GPIO_PUR(base)      REG((base) + 0x510)
#define GPIO_DEN(base)      REG((base) + 0x51C)

#define GPIOK_BASE          0x40061000u
#define GPIOL_BASE          0x40062000u
#define GPIOM_BASE          0x40063000u

#define PORT_K              (1u << 9)
#define PORT_L              (1u << 10)
#define PORT_M              (1u << 11)

/* Pins */
#define KP_X                0x0Fu              /* PM0..PM3: Spalten X1..X4 (Ausgang) */
#define KP_Y                0xF0u              /* PM4..PM7: Zeilen Y1..Y4 (Eingang) */
#define BCD_DATA            0xFFu              /* PK0..PK7: D0..D7 */
#define BCD_EN_RECHTS       (1u << 0)          /* PL0: Modul mit Ziffer 1 und 0 */
#define BCD_EN_LINKS        (1u << 1)          /* PL1: Modul mit Ziffer 3 und 2 */

/* Wartezeit nach dem Umschalten einer Spalte (Schleifendurchläufe, ca. 0,4 us bei 16 MHz) */
#define WAIT_SCAN           400u
/* Eine Tastenänderung gilt erst, wenn sie so viele Abfragen hintereinander gleich ist (Prellen) */
#define ENTPRELLEN          8u

/* Tastenbelegung: taste[Zeile Y][Spalte X] (Bild 1 im Laborskript) */
static const char tastenname[4][4] = {
    { '1', '2', '3', 'F' },
    { '4', '5', '6', 'E' },
    { '7', '8', '9', 'D' },
    { 'A', '0', 'B', 'C' },
};
static const uint8_t tastenwert[4][4] = {
    { 0x1, 0x2, 0x3, 0xF },
    { 0x4, 0x5, 0x6, 0xE },
    { 0x7, 0x8, 0x9, 0xD },
    { 0xA, 0x0, 0xB, 0xC },
};

/* Warteschleife aus dem Laborskript (Anhang 1); volatile, damit der Compiler sie nicht entfernt */
static void wait(unsigned int steps)
{
    volatile unsigned int j;
    for (j = 0; j < steps; j++)
    {
    }
}

static void ports_init(void)
{
    SYSCTL_RCGCGPIO |= PORT_K | PORT_L | PORT_M;
    while ((SYSCTL_PRGPIO & (PORT_K | PORT_L | PORT_M)) != (PORT_K | PORT_L | PORT_M))
    {
    }
    /* Keypad: X Ausgang (Ruhe = 1), Y Eingang. Der Pull-up sitzt auf dem Keypad; der interne
     * Pull-up schadet nicht und hält Y auch ohne angeschlossenes Keypad auf 1. */
    GPIO_DATA_M(GPIOM_BASE, KP_X) = KP_X;
    GPIO_DIR(GPIOM_BASE) = (GPIO_DIR(GPIOM_BASE) | KP_X) & ~KP_Y;
    GPIO_PUR(GPIOM_BASE) |= KP_Y;
    GPIO_DEN(GPIOM_BASE) |= KP_X | KP_Y;

    /* BCD-Anzeige: alles Ausgang, Freigaben aus */
    GPIO_DATA_M(GPIOL_BASE, BCD_EN_RECHTS | BCD_EN_LINKS) = 0;
    GPIO_DIR(GPIOK_BASE) |= BCD_DATA;
    GPIO_DEN(GPIOK_BASE) |= BCD_DATA;
    GPIO_DIR(GPIOL_BASE) |= BCD_EN_RECHTS | BCD_EN_LINKS;
    GPIO_DEN(GPIOL_BASE) |= BCD_EN_RECHTS | BCD_EN_LINKS;
}

/*
 * Ein Durchlauf über alle vier Spalten. Liefert die Anzahl gedrückter Tasten; bei genau einer
 * Taste stehen Zeile und Spalte in *zeile / *spalte.
 */
static uint32_t keypad_scan(uint32_t *zeile, uint32_t *spalte)
{
    uint32_t anzahl = 0;
    for (uint32_t x = 0; x < 4u; x++)
    {
        GPIO_DATA_M(GPIOM_BASE, KP_X) = ~(1u << x) & KP_X;  /* nur Spalte x auf 0 */
        wait(WAIT_SCAN);                                    /* Laufzeit der Leitungen abwarten */
        uint32_t y = (~GPIO_DATA_M(GPIOM_BASE, KP_Y) & KP_Y) >> 4; /* 1 = Zeile auf 0 gezogen */
        for (uint32_t r = 0; r < 4u; r++)
        {
            if (y & (1u << r))
            {
                anzahl++;
                *zeile = r;
                *spalte = x;
            }
        }
    }
    GPIO_DATA_M(GPIOM_BASE, KP_X) = KP_X;                   /* Ruhezustand */
    return anzahl;
}

/* Schreibt einen Wert (zwei BCD-Ziffern) in ein Modul: Daten anlegen, EN kurz auf 1 */
static void bcd_schreiben(uint32_t en, uint8_t zweiZiffern)
{
    GPIO_DATA_M(GPIOK_BASE, BCD_DATA) = zweiZiffern;
    GPIO_DATA_M(GPIOL_BASE, en) = en;
    wait(10u);
    GPIO_DATA_M(GPIOL_BASE, en) = 0;
}

/* Zeigt vier Ziffern an (Ziffer 3 = links ... Ziffer 0 = rechts, je 4 Bit) */
static void bcd_anzeigen(uint16_t ziffern)
{
    bcd_schreiben(BCD_EN_RECHTS, (uint8_t)(ziffern & 0xFFu));
    bcd_schreiben(BCD_EN_LINKS, (uint8_t)(ziffern >> 8));
}

int main(void)
{
    ports_init();
    bcd_anzeigen(0x0000u);
    printf("Lab 1: Hex-Keypad an PM0..PM7, BCD-Anzeige an PK0..PK7 / PL0..PL1\n");

    /* Zustand: 0 = keine Taste, 1 = eine Taste (letzteTaste), 2 = mehrere Tasten */
    uint32_t zustand = 0, kandidat = 0, gleich = 0;
    uint32_t letzteTaste = 0, kandidatTaste = 0;
    uint16_t anzeige = 0;

    while (1)
    {
        uint32_t zeile = 0, spalte = 0;
        uint32_t n = keypad_scan(&zeile, &spalte);
        uint32_t neu = n == 0 ? 0u : (n == 1 ? 1u : 2u);
        uint32_t taste = zeile * 4u + spalte;

        /* Entprellen: neuer Zustand muss mehrmals hintereinander gleich gelesen werden */
        if (neu != kandidat || (neu == 1u && taste != kandidatTaste))
        {
            kandidat = neu;
            kandidatTaste = taste;
            gleich = 0;
            continue;
        }
        if (gleich < ENTPRELLEN)
        {
            gleich++;
            continue;
        }
        if (neu == zustand && (neu != 1u || taste == letzteTaste))
        {
            continue;                                       /* nichts Neues: nichts ausgeben */
        }

        zustand = neu;
        if (neu == 1u)
        {
            letzteTaste = taste;
            printf("Taste %c\n", tastenname[zeile][spalte]);       /* Anforderung 1 */
            anzeige = (uint16_t)((anzeige << 4) | tastenwert[zeile][spalte]);
            bcd_anzeigen(anzeige);                                 /* 4.2 */
        }
        else if (neu == 2u)
        {
            printf("Fehler: mehrere Tasten gleichzeitig gedrueckt\n"); /* Anforderung 2 */
        }
    }
}
