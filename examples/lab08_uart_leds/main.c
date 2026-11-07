/*
 * Lab 08 - Mikrocontroller per UART vom PC steuern (IE4-MCL, "Controlling a microcontroller
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
#define SYSCTL_RCGCUART     REG(0x400FE000 + 0x618)
#define SYSCTL_PRGPIO       REG(0x400FE000 + 0xA08)
#define SYSCTL_PRUART       REG(0x400FE000 + 0xA18)

#define GPIO_DATA_M(base,m) REG((base) + ((m) << 2))
#define GPIO_DIR(base)      REG((base) + 0x400)
#define GPIO_IS(base)       REG((base) + 0x404)
#define GPIO_IBE(base)      REG((base) + 0x408)
#define GPIO_IEV(base)      REG((base) + 0x40C)
#define GPIO_IM(base)       REG((base) + 0x410)
#define GPIO_ICR(base)      REG((base) + 0x41C)
#define GPIO_AFSEL(base)    REG((base) + 0x420)
#define GPIO_PUR(base)      REG((base) + 0x510)
#define GPIO_DEN(base)      REG((base) + 0x51C)
#define GPIO_PCTL(base)     REG((base) + 0x52C)

#define GPIOA_BASE          0x40058000u
#define GPIOF_BASE          0x4005D000u
#define GPIOJ_BASE          0x40060000u
#define GPION_BASE          0x40064000u
#define PORT_A              (1u << 0)
#define PORT_F              (1u << 5)
#define PORT_J              (1u << 8)
#define PORT_N              (1u << 12)

#define UART0_DR            REG(0x4000C000 + 0x000)
#define UART0_FR            REG(0x4000C000 + 0x018)
#define UART0_IBRD          REG(0x4000C000 + 0x024)
#define UART0_FBRD          REG(0x4000C000 + 0x028)
#define UART0_LCRH          REG(0x4000C000 + 0x02C)
#define UART0_CTL           REG(0x4000C000 + 0x030)
#define UART_FR_RXFE        (1u << 4)
#define UART_FR_TXFF        (1u << 5)
#define UART_LCRH_WLEN_7    (0x2u << 5)          /* 7 Datenbits, keine Parität, 1 Stoppbit, ohne FIFO */
#define UART_CTL_UARTEN     (1u << 0)
#define UART_CTL_TXE        (1u << 8)
#define UART_CTL_RXE        (1u << 9)

#define NVIC_EN1            REG(0xE000E104)      /* IRQ 32..63 */
#define IRQ_GPIOJ           51u

/* Pins */
#define LED_D1              (1u << 1)            /* PN1 */
#define LED_D2              (1u << 0)            /* PN0 */
#define LED_D3              (1u << 4)            /* PF4 */
#define LED_D4              (1u << 0)            /* PF0 */
#define SW1                 (1u << 0)            /* PJ0 */

/* ---------------------------------------------------------------------------------------------
 * LEDs 1..4
 * ------------------------------------------------------------------------------------------- */
static bool led_an(uint32_t nr)
{
    switch (nr)
    {
        case 1: return GPIO_DATA_M(GPION_BASE, LED_D1) != 0;
        case 2: return GPIO_DATA_M(GPION_BASE, LED_D2) != 0;
        case 3: return GPIO_DATA_M(GPIOF_BASE, LED_D3) != 0;
        default: return GPIO_DATA_M(GPIOF_BASE, LED_D4) != 0;
    }
}

static void led_setzen(uint32_t nr, bool an)
{
    switch (nr)
    {
        case 1: GPIO_DATA_M(GPION_BASE, LED_D1) = an ? LED_D1 : 0; break;
        case 2: GPIO_DATA_M(GPION_BASE, LED_D2) = an ? LED_D2 : 0; break;
        case 3: GPIO_DATA_M(GPIOF_BASE, LED_D3) = an ? LED_D3 : 0; break;
        default: GPIO_DATA_M(GPIOF_BASE, LED_D4) = an ? LED_D4 : 0; break;
    }
}

/* ---------------------------------------------------------------------------------------------
 * UART0
 * ------------------------------------------------------------------------------------------- */
static void configPortA(void)
{
    SYSCTL_RCGCGPIO |= PORT_A;
    while ((SYSCTL_PRGPIO & PORT_A) == 0) {}
    GPIO_DEN(GPIOA_BASE) |= 0x03u;                 /* PA1:0 digital */
    GPIO_AFSEL(GPIOA_BASE) |= 0x03u;               /* PA1:0 alternative Funktion */
    GPIO_PCTL(GPIOA_BASE) = (GPIO_PCTL(GPIOA_BASE) & ~0xFFu) | 0x11u;   /* U0RX, U0TX */
}

static void configUart0(void)
{
    SYSCTL_RCGCUART |= 1u;
    while ((SYSCTL_PRUART & 1u) == 0) {}
    UART0_CTL &= ~UART_CTL_UARTEN;                 /* zum Konfigurieren ausschalten */
    UART0_IBRD = 104;                              /* 16 MHz / (16 * 9600) = 104,17 */
    UART0_FBRD = 11;                               /* 0,17 * 64 = 10,7 -> 11 */
    UART0_LCRH = UART_LCRH_WLEN_7;                 /* 7N1; übernimmt auch IBRD/FBRD */
    UART0_CTL |= UART_CTL_RXE | UART_CTL_TXE | UART_CTL_UARTEN;
}

static void uart_putc(char c)
{
    while (UART0_FR & UART_FR_TXFF) {}
    UART0_DR = (uint8_t)c;
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
    GPIO_ICR(GPIOJ_BASE) = SW1;                         /* am Ende löschen: weniger Prellen */
}
/* Name in der Vektortabelle von common/startup_tm4c1294.c */
void GPIOJ_Handler(void) __attribute__((alias("IntPortJHandler")));

static void configPortJ(void)
{
    SYSCTL_RCGCGPIO |= PORT_J;
    while ((SYSCTL_PRGPIO & PORT_J) == 0) {}
    GPIO_DIR(GPIOJ_BASE) &= ~SW1;
    GPIO_PUR(GPIOJ_BASE) |= SW1;                   /* Taster braucht den internen Pull-up */
    GPIO_DEN(GPIOJ_BASE) |= SW1;
    GPIO_IM(GPIOJ_BASE) &= ~SW1;                   /* Datenblatt: erst maskieren ... */
    GPIO_IS(GPIOJ_BASE) &= ~SW1;                   /* Flanke */
    GPIO_IBE(GPIOJ_BASE) &= ~SW1;                  /* eine Flanke ... */
    GPIO_IEV(GPIOJ_BASE) |= SW1;                   /* ... und zwar steigend */
    GPIO_ICR(GPIOJ_BASE) = SW1;                    /* ... dann alte Ereignisse löschen */
    GPIO_IM(GPIOJ_BASE) |= SW1;
    NVIC_EN1 = 1u << (IRQ_GPIOJ - 32u);
}

static void configLeds(void)
{
    SYSCTL_RCGCGPIO |= PORT_N | PORT_F;
    while ((SYSCTL_PRGPIO & (PORT_N | PORT_F)) != (PORT_N | PORT_F)) {}
    GPIO_DIR(GPION_BASE) |= LED_D1 | LED_D2;
    GPIO_DEN(GPION_BASE) |= LED_D1 | LED_D2;
    GPIO_DIR(GPIOF_BASE) |= LED_D3 | LED_D4;
    GPIO_DEN(GPIOF_BASE) |= LED_D3 | LED_D4;
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
        if (UART0_FR & UART_FR_RXFE) continue;
        unsigned char c = (unsigned char)(UART0_DR & 0x7Fu);
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
