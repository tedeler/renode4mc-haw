#include <stdint.h>

/* Echte Registeradressen des TM4C1294NCPDT */
#define SYSCTL_RCGCGPIO_R   (*((volatile uint32_t *)0x400FE608))
#define SYSCTL_PRGPIO_R     (*((volatile uint32_t *)0x400FEA08))
#define GPIO_PORTN_DATA_R   (*((volatile uint32_t *)0x400643FC))
#define GPIO_PORTN_DIR_R    (*((volatile uint32_t *)0x40064400))
#define GPIO_PORTN_DEN_R    (*((volatile uint32_t *)0x4006451C))

void Reset_Handler(void);
static void Default_Handler(void) { while (1); }

/* Stack-Top (Ende der 256 KB SRAM: 0x20000000 + 0x40000) */
extern uint32_t __stack_top;

/* ARM Cortex-M4 Vektortabelle in eigener Sektion */
__attribute__((section(".intvecs"), used))
void (* const g_pfnVectors[])(void) = {
    (void (*)(void))(&__stack_top),
    Reset_Handler,
    Default_Handler, /* NMI */
    Default_Handler  /* HardFault */
};

int main(void) {
    /* 1. Clock für GPIO Port N (Bit 12) aktivieren und auf Ready warten */
    SYSCTL_RCGCGPIO_R |= (1U << 12);
    while ((SYSCTL_PRGPIO_R & (1U << 12)) == 0) {}

    /* 2. PN0 und PN1 (LEDs D2 und D1) als digitale Ausgänge konfigurieren */
    GPIO_PORTN_DIR_R |= 0x03;
    GPIO_PORTN_DEN_R |= 0x03;

    /* 3. Endlosschleife: PN0 toggeln */
    while (1) {
        GPIO_PORTN_DATA_R ^= 0x01;
        for (volatile uint32_t i = 0; i < 5000000; i++) {}
    }
}

void Reset_Handler(void) {
    main();
    while (1);
}
