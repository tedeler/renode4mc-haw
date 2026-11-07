/*
 * Lab 04 - Mikrocontroller per UART vom PC steuern (IE4-MCL, "Controlling a microcontroller
 * with the PC via UART protocol")
 * Board: EK-TM4C1294XL (TM4C1294NCPDT), Takt: 16 MHz (Reset-Takt, wird hier nicht verändert)
 *
 * Läuft im Simulator (Web-Konsole, Versuch "lab4_uart") und auf dem Board mit Tera Term
 * (9600 Bit/s, 7N1, Local echo, New-line Receive CR+LF – wie im Laborskript).
 *
 *   Baustein                 Anschluss                          Verwendung im Programm
 *   ------------------------ ---------------------------------- -------------------------------------
 *   UART0 (Virtual COM)      PA0 = U0RX, PA1 = U0TX              9600 Bit/s 7N1, Prompt '>', Befehle
 *   LEDs D1..D4              PN1, PN0, PF4, PF0 (Ausgang)        per Befehl "leds +1-2~3" schalten
 *   Taster USR_SW1           PJ0 (Eingang, interner Pull-up)     Interrupt bei steigender Flanke
 *                                                                (Loslassen): "#<LEDs an><CR>" senden
 *   CCS-Konsole              printf()                            empfangene Befehlszeile
 *
 * Aufgaben aus dem Laborskript:
 *   3.1  UART0 7N1 9600 Bit/s: IBRD = 104, FBRD = 11 bei 16 MHz
 *        (16 MHz / (16 * 9600) = 104,1667 -> FBRD = round(0,1667 * 64) = 11;
 *         tatsächlich 16e6 / (16 * (104 + 11/64)) = 9600,2 Bit/s, Fehler +0,002 %)
 *   3.2  Prompt '>', Empfang per Abfrage, aber nicht blockierend, in cmdLineUart[16];
 *        bei CR (0x0D) oder dem 16. Zeichen abschließen und mit printf() ausgeben
 *   3.3/4.1  cmdToLed(): "leds <+|-|~><1..4>[<+|-|~><1..4>]..." – bei einem Syntaxfehler wird
 *        ab dieser Stelle abgebrochen (vorher ausgeführte Teile bleiben gültig)
 *   4.2  IntPortJHandler(): SW1 (PJ0) mit Interrupt bei steigender Flanke, sendet '#', die
 *        Nummern der leuchtenden LEDs und CR. Steht in der Vektortabelle als GPIOJ_Handler
 *        (common/startup_tm4c1294.c), hier per Alias.
 *
 * Registernamen und Bitkonstanten: TI-Headerdatei tm4c1294ncpdt.h (common/), keine eigenen
 * Adressen. Nachschlagen im Datenblatt "TM4C1294NCPDT" (SPMS433).
 */
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include "tm4c1294ncpdt.h"

/* ---------------------------------------------------------------------------------------------
 * Register: alle Namen (..._R) und Bitkonstanten kommen aus tm4c1294ncpdt.h (common/).
 * Ports A-J heißen dort GPIO_PORTx_AHB_..._R (hier A, F, J), die Ports K-Q ohne AHB (hier N).
 * GPIO_PORTx_DATA_BITS_R[m]: Zugriff nur auf die Pins in Maske m (Adressmaskierung, Bits 9:2).
 * Hier stehen nur Konstanten, die die Headerdatei nicht kennt (Pins, Pin-Funktionen, IRQs).
 * ------------------------------------------------------------------------------------------- */
/* GPIOPCTL: je 4 Bit pro Pin wählen die alternative Funktion (Datenblatt, Tabelle
 * "GPIO Pins and Alternate Functions"). Dafür hat die Headerdatei keine Konstanten. */
#define PCTL_MASKE(pin)     (0xFu << (4u * (pin)))
#define PCTL_FUNKTION(pin, f) ((uint32_t)(f) << (4u * (pin)))
#define PCTL_UART0          1u                   /* PA0 = U0RX, PA1 = U0TX */

/* NVIC: INT_... aus der Headerdatei ist die Nummer in der Vektortabelle; der NVIC zählt
 * ab dem ersten Peripherie-Interrupt (Eintrag 16). EN1 = IRQ 32..63. */
#define IRQ_GPIOJ           (INT_GPIOJ - 16u)    /* 51 */

/* Pins */
#define LED_D1              (1u << 1)            /* PN1 */
#define LED_D2              (1u << 0)            /* PN0 */
#define LED_D3              (1u << 4)            /* PF4 */
#define LED_D4              (1u << 0)            /* PF0 */
#define SW1                 (1u << 0)            /* PJ0 */
#define PINS_UART0          0x03u                /* PA0 = U0RX, PA1 = U0TX */
#define ZEICHEN_7BIT        0x7Fu                /* 7N1: nur Bits 6:0 sind Daten */

/* ---------------------------------------------------------------------------------------------
 * LEDs 1..4
 * ------------------------------------------------------------------------------------------- */
static bool led_an(uint32_t nr)
{
    switch (nr)
    {
        case 1: return GPIO_PORTN_DATA_BITS_R[LED_D1] != 0;
        case 2: return GPIO_PORTN_DATA_BITS_R[LED_D2] != 0;
        case 3: return GPIO_PORTF_AHB_DATA_BITS_R[LED_D3] != 0;
        default: return GPIO_PORTF_AHB_DATA_BITS_R[LED_D4] != 0;
    }
}

static void led_setzen(uint32_t nr, bool an)
{
    switch (nr)
    {
        case 1: GPIO_PORTN_DATA_BITS_R[LED_D1] = an ? LED_D1 : 0; break;
        case 2: GPIO_PORTN_DATA_BITS_R[LED_D2] = an ? LED_D2 : 0; break;
        case 3: GPIO_PORTF_AHB_DATA_BITS_R[LED_D3] = an ? LED_D3 : 0; break;
        default: GPIO_PORTF_AHB_DATA_BITS_R[LED_D4] = an ? LED_D4 : 0; break;
    }
}

/* ---------------------------------------------------------------------------------------------
 * UART0
 * ------------------------------------------------------------------------------------------- */
static void configPortA(void)
{
    SYSCTL_RCGCGPIO_R |= SYSCTL_RCGCGPIO_R0;
    while ((SYSCTL_PRGPIO_R & SYSCTL_PRGPIO_R0) == 0) {}
    GPIO_PORTA_AHB_DEN_R |= PINS_UART0;             /* PA1:0 digital */
    GPIO_PORTA_AHB_AFSEL_R |= PINS_UART0;           /* PA1:0 alternative Funktion */
    GPIO_PORTA_AHB_PCTL_R = (GPIO_PORTA_AHB_PCTL_R & ~(PCTL_MASKE(0) | PCTL_MASKE(1)))
                          | PCTL_FUNKTION(0, PCTL_UART0) | PCTL_FUNKTION(1, PCTL_UART0);
}

static void configUart0(void)
{
    SYSCTL_RCGCUART_R |= SYSCTL_RCGCUART_R0;
    while ((SYSCTL_PRUART_R & SYSCTL_PRUART_R0) == 0) {}
    UART0_CTL_R &= ~UART_CTL_UARTEN;               /* zum Konfigurieren ausschalten */
    UART0_IBRD_R = 104;                            /* 16 MHz / (16 * 9600) = 104,17 */
    UART0_FBRD_R = 11;                             /* 0,17 * 64 = 10,7 -> 11 */
    UART0_LCRH_R = UART_LCRH_WLEN_7;               /* 7N1 ohne FIFO; übernimmt auch IBRD/FBRD */
    UART0_CTL_R |= UART_CTL_RXE | UART_CTL_TXE | UART_CTL_UARTEN;
}

static void uart_putc(char c)
{
    while (UART0_FR_R & UART_FR_TXFF) {}
    UART0_DR_R = (uint8_t)c;
}

/* ---------------------------------------------------------------------------------------------
 * 4.2: SW1 (PJ0) – Interrupt beim Loslassen (steigende Flanke, Taster gegen GND mit Pull-up)
 * ------------------------------------------------------------------------------------------- */
void IntPortJHandler(void)
{
    uart_putc('#');
    for (uint32_t nr = 1; nr <= 4u; nr++)
    {
        if (led_an(nr)) uart_putc((char)('0' + nr));   /* ASCII: '1' = 0x31 */
    }
    uart_putc('\r');
    GPIO_PORTJ_AHB_ICR_R = SW1;                         /* am Ende löschen: weniger Prellen */
}
/* Name in der Vektortabelle von common/startup_tm4c1294.c */
void GPIOJ_Handler(void) __attribute__((alias("IntPortJHandler")));

static void configPortJ(void)
{
    SYSCTL_RCGCGPIO_R |= SYSCTL_RCGCGPIO_R8;
    while ((SYSCTL_PRGPIO_R & SYSCTL_PRGPIO_R8) == 0) {}
    GPIO_PORTJ_AHB_DIR_R &= ~SW1;
    GPIO_PORTJ_AHB_PUR_R |= SW1;                   /* Taster braucht den internen Pull-up */
    GPIO_PORTJ_AHB_DEN_R |= SW1;
    GPIO_PORTJ_AHB_IM_R &= ~SW1;                   /* Datenblatt: erst maskieren ... */
    GPIO_PORTJ_AHB_IS_R &= ~SW1;                   /* Flanke */
    GPIO_PORTJ_AHB_IBE_R &= ~SW1;                  /* eine Flanke ... */
    GPIO_PORTJ_AHB_IEV_R |= SW1;                   /* ... und zwar steigend */
    GPIO_PORTJ_AHB_ICR_R = SW1;                    /* ... dann alte Ereignisse löschen */
    GPIO_PORTJ_AHB_IM_R |= SW1;
    NVIC_EN1_R = 1u << (IRQ_GPIOJ - 32u);
}

static void configLeds(void)
{
    SYSCTL_RCGCGPIO_R |= SYSCTL_RCGCGPIO_R12 | SYSCTL_RCGCGPIO_R5;          /* N, F */
    while ((SYSCTL_PRGPIO_R & (SYSCTL_PRGPIO_R12 | SYSCTL_PRGPIO_R5)) !=
           (SYSCTL_PRGPIO_R12 | SYSCTL_PRGPIO_R5)) {}
    GPIO_PORTN_DIR_R |= LED_D1 | LED_D2;
    GPIO_PORTN_DEN_R |= LED_D1 | LED_D2;
    GPIO_PORTF_AHB_DIR_R |= LED_D3 | LED_D4;
    GPIO_PORTF_AHB_DEN_R |= LED_D3 | LED_D4;
}

/* ---------------------------------------------------------------------------------------------
 * 3.3/4.1: Befehl auswerten
 *   leds <+|-|~><1|2|3|4>[<+|-|~><1|2|3|4>]...
 * Bei einem Syntaxfehler wird ab dieser Stelle abgebrochen. Rückgabe: true = ganz ausgeführt.
 * ------------------------------------------------------------------------------------------- */
unsigned char cmdLineUart[16];

bool cmdToLed(const unsigned char *cmd)
{
    static const char wort[] = "leds ";
    for (uint32_t i = 0; wort[i]; i++)
    {
        if (cmd[i] != (unsigned char)wort[i]) return false;
    }
    const unsigned char *p = cmd + 5;
    if (*p == '\0') return false;                  /* mindestens ein Paar */
    while (*p != '\0')
    {
        unsigned char op = p[0], nr = p[1];
        if ((op != '+' && op != '-' && op != '~') || nr < '1' || nr > '4') return false;
        uint32_t led = (uint32_t)(nr - '0');
        if (op == '+') led_setzen(led, true);
        else if (op == '-') led_setzen(led, false);
        else led_setzen(led, !led_an(led));
        p += 2;
    }
    return true;
}

int main(void)
{
    configLeds();
    configPortA();
    configUart0();
    configPortJ();

    uint32_t n = 0;
    uart_putc('>');                                /* Prompt */
    while (1)
    {
        /* nicht blockierend: nur lesen, wenn ein Zeichen da ist */
        if (UART0_FR_R & UART_FR_RXFE) continue;
        unsigned char c = (unsigned char)(UART0_DR_R & ZEICHEN_7BIT);
        cmdLineUart[n++] = c;
        if (c == 0x0D || n == sizeof cmdLineUart)
        {
            cmdLineUart[n - 1] = '\0';             /* CR bzw. 16. Zeichen durch '\0' ersetzen */
            printf("%s\n", (char *)cmdLineUart);
            if (!cmdToLed(cmdLineUart))
            {
                printf("Syntaxfehler, abgebrochen: \"%s\"\n", (char *)cmdLineUart);
            }
            n = 0;
            uart_putc('>');
        }
    }
}
