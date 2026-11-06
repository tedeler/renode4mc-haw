/*
 * startup_tm4c1294.c - Startcode und Interrupt-Vektortabelle für den TM4C1294NCPDT
 *
 * Eigene Datei (unabhängig vom TI-Startup). Funktioniert mit TI Arm Clang (CCS)
 * und im Simulator identisch.
 *
 * Ablauf nach Reset:  CPU liest SP und Reset-Vektor aus der Tabelle -> ResetISR
 *                     -> _c_int00 (Laufzeitsystem: .data kopieren, .bss löschen) -> main()
 *
 * Eine Interrupt-Routine schreiben Sie einfach mit dem Namen aus der Tabelle, z. B.
 *     void TIMER0A_Handler(void) { ... }
 * Nicht definierte Handler sind "weak" und zeigen auf IntDefaultHandler (Endlosschleife).
 */
#include <stdint.h>

extern void _c_int00(void);        /* Einstieg des TI-Laufzeitsystems */
extern uint32_t __STACK_TOP;       /* vom Linker-Skript definiert */

void ResetISR(void);
void IntDefaultHandler(void);
void NMI_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void HardFault_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void MemManage_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void BusFault_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void UsageFault_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void SVC_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void DebugMon_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void PendSV_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void SysTick_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOA_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOB_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOC_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOD_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOE_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void UART0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void UART1_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void SSI0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void I2C0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void PWM0_FAULT_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void PWM0_0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void PWM0_1_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void PWM0_2_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void QEI0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void ADC0SS0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void ADC0SS1_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void ADC0SS2_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void ADC0SS3_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void WATCHDOG_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER0A_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER0B_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER1A_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER1B_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER2A_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER2B_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void COMP0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void COMP1_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void COMP2_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void SYSCTL_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void FLASH_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOF_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOG_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOH_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void UART2_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void SSI1_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER3A_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER3B_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void I2C1_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void CAN0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void CAN1_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void EMAC0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void HIBERNATE_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void USB0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void PWM0_3_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void UDMA_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void UDMAERR_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void ADC1SS0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void ADC1SS1_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void ADC1SS2_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void ADC1SS3_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void EPI0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOJ_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOK_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOL_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void SSI2_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void SSI3_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void UART3_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void UART4_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void UART5_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void UART6_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void UART7_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void I2C2_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void I2C3_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER4A_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER4B_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER5A_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER5B_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void SYSEXC_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void I2C4_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void I2C5_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOM_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPION_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TAMPER0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOP0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOP1_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOP2_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOP3_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOP4_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOP5_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOP6_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOP7_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOQ0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOQ1_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOQ2_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOQ3_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOQ4_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOQ5_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOQ6_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOQ7_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOR_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOS_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void SHA0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void AES0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void DES0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void LCD0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER6A_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER6B_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER7A_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER7B_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void I2C6_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void I2C7_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void ONEWIRE0_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void I2C8_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void I2C9_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void GPIOT_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));

/* Vektortabelle: wird vom Linker-Skript an Adresse 0x0 (Flash-Anfang) gelegt. */
__attribute__((section(".intvecs"), used))
void (* const g_pfnVectors[])(void) =
{
    (void (*)(void))((uint32_t)&__STACK_TOP),   /*  0: Anfangswert Stackpointer */
    ResetISR,                                   /*  1: Reset */
    NMI_Handler,                /*   2: NMI */
    HardFault_Handler,          /*   3: HardFault */
    MemManage_Handler,          /*   4: MemManage */
    BusFault_Handler,           /*   5: BusFault */
    UsageFault_Handler,         /*   6: UsageFault */
    0,                          /*   7: - */
    0,                          /*   8: - */
    0,                          /*   9: - */
    0,                          /*  10: - */
    SVC_Handler,                /*  11: SVC */
    DebugMon_Handler,           /*  12: DebugMon */
    0,                          /*  13: - */
    PendSV_Handler,             /*  14: PendSV */
    SysTick_Handler,            /*  15: SysTick */
    GPIOA_Handler,              /*  16: IRQ   0  GPIO Port A */
    GPIOB_Handler,              /*  17: IRQ   1  GPIO Port B */
    GPIOC_Handler,              /*  18: IRQ   2  GPIO Port C */
    GPIOD_Handler,              /*  19: IRQ   3  GPIO Port D */
    GPIOE_Handler,              /*  20: IRQ   4  GPIO Port E */
    UART0_Handler,              /*  21: IRQ   5  UART0 */
    UART1_Handler,              /*  22: IRQ   6  UART1 */
    SSI0_Handler,               /*  23: IRQ   7  SSI0 */
    I2C0_Handler,               /*  24: IRQ   8  I2C0 */
    PWM0_FAULT_Handler,         /*  25: IRQ   9  PWM Fault */
    PWM0_0_Handler,             /*  26: IRQ  10  PWM Generator 0 */
    PWM0_1_Handler,             /*  27: IRQ  11  PWM Generator 1 */
    PWM0_2_Handler,             /*  28: IRQ  12  PWM Generator 2 */
    QEI0_Handler,               /*  29: IRQ  13  QEI0 */
    ADC0SS0_Handler,            /*  30: IRQ  14  ADC0 Sequence 0 */
    ADC0SS1_Handler,            /*  31: IRQ  15  ADC0 Sequence 1 */
    ADC0SS2_Handler,            /*  32: IRQ  16  ADC0 Sequence 2 */
    ADC0SS3_Handler,            /*  33: IRQ  17  ADC0 Sequence 3 */
    WATCHDOG_Handler,           /*  34: IRQ  18  Watchdog Timers 0 and 1 */
    TIMER0A_Handler,            /*  35: IRQ  19  16/32-Bit Timer 0A */
    TIMER0B_Handler,            /*  36: IRQ  20  16/32-Bit Timer 0B */
    TIMER1A_Handler,            /*  37: IRQ  21  16/32-Bit Timer 1A */
    TIMER1B_Handler,            /*  38: IRQ  22  16/32-Bit Timer 1B */
    TIMER2A_Handler,            /*  39: IRQ  23  16/32-Bit Timer 2A */
    TIMER2B_Handler,            /*  40: IRQ  24  16/32-Bit Timer 2B */
    COMP0_Handler,              /*  41: IRQ  25  Analog Comparator 0 */
    COMP1_Handler,              /*  42: IRQ  26  Analog Comparator 1 */
    COMP2_Handler,              /*  43: IRQ  27  Analog Comparator 2 */
    SYSCTL_Handler,             /*  44: IRQ  28  System Control */
    FLASH_Handler,              /*  45: IRQ  29  Flash Memory Control */
    GPIOF_Handler,              /*  46: IRQ  30  GPIO Port F */
    GPIOG_Handler,              /*  47: IRQ  31  GPIO Port G */
    GPIOH_Handler,              /*  48: IRQ  32  GPIO Port H */
    UART2_Handler,              /*  49: IRQ  33  UART2 */
    SSI1_Handler,               /*  50: IRQ  34  SSI1 */
    TIMER3A_Handler,            /*  51: IRQ  35  16/32-Bit Timer 3A */
    TIMER3B_Handler,            /*  52: IRQ  36  16/32-Bit Timer 3B */
    I2C1_Handler,               /*  53: IRQ  37  I2C1 */
    CAN0_Handler,               /*  54: IRQ  38  CAN 0 */
    CAN1_Handler,               /*  55: IRQ  39  CAN1 */
    EMAC0_Handler,              /*  56: IRQ  40  Ethernet MAC */
    HIBERNATE_Handler,          /*  57: IRQ  41  HIB */
    USB0_Handler,               /*  58: IRQ  42  USB MAC */
    PWM0_3_Handler,             /*  59: IRQ  43  PWM Generator 3 */
    UDMA_Handler,               /*  60: IRQ  44  uDMA 0 Software */
    UDMAERR_Handler,            /*  61: IRQ  45  uDMA 0 Error */
    ADC1SS0_Handler,            /*  62: IRQ  46  ADC1 Sequence 0 */
    ADC1SS1_Handler,            /*  63: IRQ  47  ADC1 Sequence 1 */
    ADC1SS2_Handler,            /*  64: IRQ  48  ADC1 Sequence 2 */
    ADC1SS3_Handler,            /*  65: IRQ  49  ADC1 Sequence 3 */
    EPI0_Handler,               /*  66: IRQ  50  EPI 0 */
    GPIOJ_Handler,              /*  67: IRQ  51  GPIO Port J */
    GPIOK_Handler,              /*  68: IRQ  52  GPIO Port K */
    GPIOL_Handler,              /*  69: IRQ  53  GPIO Port L */
    SSI2_Handler,               /*  70: IRQ  54  SSI 2 */
    SSI3_Handler,               /*  71: IRQ  55  SSI 3 */
    UART3_Handler,              /*  72: IRQ  56  UART 3 */
    UART4_Handler,              /*  73: IRQ  57  UART 4 */
    UART5_Handler,              /*  74: IRQ  58  UART 5 */
    UART6_Handler,              /*  75: IRQ  59  UART 6 */
    UART7_Handler,              /*  76: IRQ  60  UART 7 */
    I2C2_Handler,               /*  77: IRQ  61  I2C 2 */
    I2C3_Handler,               /*  78: IRQ  62  I2C 3 */
    TIMER4A_Handler,            /*  79: IRQ  63  Timer 4A */
    TIMER4B_Handler,            /*  80: IRQ  64  Timer 4B */
    TIMER5A_Handler,            /*  81: IRQ  65  Timer 5A */
    TIMER5B_Handler,            /*  82: IRQ  66  Timer 5B */
    SYSEXC_Handler,             /*  83: IRQ  67  Floating-Point Exception */
    0,                          /*  84: IRQ  68  (reserviert) */
    0,                          /*  85: IRQ  69  (reserviert) */
    I2C4_Handler,               /*  86: IRQ  70  I2C 4 */
    I2C5_Handler,               /*  87: IRQ  71  I2C 5 */
    GPIOM_Handler,              /*  88: IRQ  72  GPIO Port M */
    GPION_Handler,              /*  89: IRQ  73  GPIO Port N */
    0,                          /*  90: IRQ  74  (reserviert) */
    TAMPER0_Handler,            /*  91: IRQ  75  Tamper */
    GPIOP0_Handler,             /*  92: IRQ  76  GPIO Port P (Summary or P0) */
    GPIOP1_Handler,             /*  93: IRQ  77  GPIO Port P1 */
    GPIOP2_Handler,             /*  94: IRQ  78  GPIO Port P2 */
    GPIOP3_Handler,             /*  95: IRQ  79  GPIO Port P3 */
    GPIOP4_Handler,             /*  96: IRQ  80  GPIO Port P4 */
    GPIOP5_Handler,             /*  97: IRQ  81  GPIO Port P5 */
    GPIOP6_Handler,             /*  98: IRQ  82  GPIO Port P6 */
    GPIOP7_Handler,             /*  99: IRQ  83  GPIO Port P7 */
    GPIOQ0_Handler,             /* 100: IRQ  84  GPIO Port Q (Summary or Q0) */
    GPIOQ1_Handler,             /* 101: IRQ  85  GPIO Port Q1 */
    GPIOQ2_Handler,             /* 102: IRQ  86  GPIO Port Q2 */
    GPIOQ3_Handler,             /* 103: IRQ  87  GPIO Port Q3 */
    GPIOQ4_Handler,             /* 104: IRQ  88  GPIO Port Q4 */
    GPIOQ5_Handler,             /* 105: IRQ  89  GPIO Port Q5 */
    GPIOQ6_Handler,             /* 106: IRQ  90  GPIO Port Q6 */
    GPIOQ7_Handler,             /* 107: IRQ  91  GPIO Port Q7 */
    GPIOR_Handler,              /* 108: IRQ  92  GPIO Port R */
    GPIOS_Handler,              /* 109: IRQ  93  GPIO Port S */
    SHA0_Handler,               /* 110: IRQ  94  SHA/MD5 */
    AES0_Handler,               /* 111: IRQ  95  AES */
    DES0_Handler,               /* 112: IRQ  96  DES */
    LCD0_Handler,               /* 113: IRQ  97  LCD */
    TIMER6A_Handler,            /* 114: IRQ  98  16/32-Bit Timer 6A */
    TIMER6B_Handler,            /* 115: IRQ  99  16/32-Bit Timer 6B */
    TIMER7A_Handler,            /* 116: IRQ 100  16/32-Bit Timer 7A */
    TIMER7B_Handler,            /* 117: IRQ 101  16/32-Bit Timer 7B */
    I2C6_Handler,               /* 118: IRQ 102  I2C 6 */
    I2C7_Handler,               /* 119: IRQ 103  I2C 7 */
    0,                          /* 120: IRQ 104  (reserviert) */
    ONEWIRE0_Handler,           /* 121: IRQ 105  1-Wire */
    0,                          /* 122: IRQ 106  (reserviert) */
    0,                          /* 123: IRQ 107  (reserviert) */
    0,                          /* 124: IRQ 108  (reserviert) */
    I2C8_Handler,               /* 125: IRQ 109  I2C 8 */
    I2C9_Handler,               /* 126: IRQ 110  I2C 9 */
    GPIOT_Handler,              /* 127: IRQ 111  GPIO T */
};

void ResetISR(void)
{
    _c_int00();
}

void IntDefaultHandler(void)
{
    /* Unerwarteter Interrupt/Fault: im Debugger hier anhalten und "Call Stack" ansehen. */
    while(1)
    {
    }
}
