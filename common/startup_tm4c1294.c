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
 *
 * Die Plätze der Peripherie-Interrupts kommen aus tm4c1294ncpdt.h (INT_<Name> = Nummer des
 * Eintrags in dieser Tabelle; die NVIC-/IRQ-Nummer ist INT_<Name> - 16). Ein Handler steht so
 * immer an der Stelle, die die Headerdatei vorgibt. Einträge ohne INT_-Konstante sind auf diesem
 * Chip reserviert und bleiben 0.
 */
#include <stdint.h>
#include "tm4c1294ncpdt.h"

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
void TIMER6A_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER6B_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER7A_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void TIMER7B_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void I2C6_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void I2C7_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void I2C8_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));
void I2C9_Handler(void) __attribute__((weak, alias("IntDefaultHandler")));

/* Anzahl der Einträge: 16 Prozessor-Ausnahmen + Peripherie bis zum letzten INT_ der Headerdatei */
#define ANZAHL_VEKTOREN     (INT_I2C9 + 1)

/* Vektortabelle: wird vom Linker-Skript an Adresse 0x0 (Flash-Anfang) gelegt. */
__attribute__((section(".intvecs"), used))
void (* const g_pfnVectors[ANZAHL_VEKTOREN])(void) =
{
    /* Prozessor-Ausnahmen (ARM Cortex-M4, fest; nicht in tm4c1294ncpdt.h) */
    [0]  = (void (*)(void))((uint32_t)&__STACK_TOP),   /* Anfangswert Stackpointer */
    [1]  = ResetISR,
    [2]  = NMI_Handler,
    [3]  = HardFault_Handler,
    [4]  = MemManage_Handler,
    [5]  = BusFault_Handler,
    [6]  = UsageFault_Handler,
    [11] = SVC_Handler,
    [12] = DebugMon_Handler,
    [14] = PendSV_Handler,
    [15] = SysTick_Handler,

    /* Peripherie-Interrupts */
    [INT_GPIOA]      = GPIOA_Handler,       /*  16: IRQ   0  GPIO Port A */
    [INT_GPIOB]      = GPIOB_Handler,       /*  17: IRQ   1  GPIO Port B */
    [INT_GPIOC]      = GPIOC_Handler,       /*  18: IRQ   2  GPIO Port C */
    [INT_GPIOD]      = GPIOD_Handler,       /*  19: IRQ   3  GPIO Port D */
    [INT_GPIOE]      = GPIOE_Handler,       /*  20: IRQ   4  GPIO Port E */
    [INT_UART0]      = UART0_Handler,       /*  21: IRQ   5  UART0 */
    [INT_UART1]      = UART1_Handler,       /*  22: IRQ   6  UART1 */
    [INT_SSI0]       = SSI0_Handler,        /*  23: IRQ   7  SSI0 */
    [INT_I2C0]       = I2C0_Handler,        /*  24: IRQ   8  I2C0 */
    [INT_PWM0_FAULT] = PWM0_FAULT_Handler,  /*  25: IRQ   9  PWM Fault */
    [INT_PWM0_0]     = PWM0_0_Handler,      /*  26: IRQ  10  PWM Generator 0 */
    [INT_PWM0_1]     = PWM0_1_Handler,      /*  27: IRQ  11  PWM Generator 1 */
    [INT_PWM0_2]     = PWM0_2_Handler,      /*  28: IRQ  12  PWM Generator 2 */
    [INT_QEI0]       = QEI0_Handler,        /*  29: IRQ  13  QEI0 */
    [INT_ADC0SS0]    = ADC0SS0_Handler,     /*  30: IRQ  14  ADC0 Sequence 0 */
    [INT_ADC0SS1]    = ADC0SS1_Handler,     /*  31: IRQ  15  ADC0 Sequence 1 */
    [INT_ADC0SS2]    = ADC0SS2_Handler,     /*  32: IRQ  16  ADC0 Sequence 2 */
    [INT_ADC0SS3]    = ADC0SS3_Handler,     /*  33: IRQ  17  ADC0 Sequence 3 */
    [INT_WATCHDOG]   = WATCHDOG_Handler,    /*  34: IRQ  18  Watchdog Timers 0 and 1 */
    [INT_TIMER0A]    = TIMER0A_Handler,     /*  35: IRQ  19  16/32-Bit Timer 0A */
    [INT_TIMER0B]    = TIMER0B_Handler,     /*  36: IRQ  20  16/32-Bit Timer 0B */
    [INT_TIMER1A]    = TIMER1A_Handler,     /*  37: IRQ  21  16/32-Bit Timer 1A */
    [INT_TIMER1B]    = TIMER1B_Handler,     /*  38: IRQ  22  16/32-Bit Timer 1B */
    [INT_TIMER2A]    = TIMER2A_Handler,     /*  39: IRQ  23  16/32-Bit Timer 2A */
    [INT_TIMER2B]    = TIMER2B_Handler,     /*  40: IRQ  24  16/32-Bit Timer 2B */
    [INT_COMP0]      = COMP0_Handler,       /*  41: IRQ  25  Analog Comparator 0 */
    [INT_COMP1]      = COMP1_Handler,       /*  42: IRQ  26  Analog Comparator 1 */
    [INT_COMP2]      = COMP2_Handler,       /*  43: IRQ  27  Analog Comparator 2 */
    [INT_SYSCTL]     = SYSCTL_Handler,      /*  44: IRQ  28  System Control */
    [INT_FLASH]      = FLASH_Handler,       /*  45: IRQ  29  Flash Memory Control */
    [INT_GPIOF]      = GPIOF_Handler,       /*  46: IRQ  30  GPIO Port F */
    [INT_GPIOG]      = GPIOG_Handler,       /*  47: IRQ  31  GPIO Port G */
    [INT_GPIOH]      = GPIOH_Handler,       /*  48: IRQ  32  GPIO Port H */
    [INT_UART2]      = UART2_Handler,       /*  49: IRQ  33  UART2 */
    [INT_SSI1]       = SSI1_Handler,        /*  50: IRQ  34  SSI1 */
    [INT_TIMER3A]    = TIMER3A_Handler,     /*  51: IRQ  35  16/32-Bit Timer 3A */
    [INT_TIMER3B]    = TIMER3B_Handler,     /*  52: IRQ  36  16/32-Bit Timer 3B */
    [INT_I2C1]       = I2C1_Handler,        /*  53: IRQ  37  I2C1 */
    [INT_CAN0]       = CAN0_Handler,        /*  54: IRQ  38  CAN 0 */
    [INT_CAN1]       = CAN1_Handler,        /*  55: IRQ  39  CAN1 */
    [INT_EMAC0]      = EMAC0_Handler,       /*  56: IRQ  40  Ethernet MAC */
    [INT_HIBERNATE]  = HIBERNATE_Handler,   /*  57: IRQ  41  HIB */
    [INT_USB0]       = USB0_Handler,        /*  58: IRQ  42  USB MAC */
    [INT_PWM0_3]     = PWM0_3_Handler,      /*  59: IRQ  43  PWM Generator 3 */
    [INT_UDMA]       = UDMA_Handler,        /*  60: IRQ  44  uDMA 0 Software */
    [INT_UDMAERR]    = UDMAERR_Handler,     /*  61: IRQ  45  uDMA 0 Error */
    [INT_ADC1SS0]    = ADC1SS0_Handler,     /*  62: IRQ  46  ADC1 Sequence 0 */
    [INT_ADC1SS1]    = ADC1SS1_Handler,     /*  63: IRQ  47  ADC1 Sequence 1 */
    [INT_ADC1SS2]    = ADC1SS2_Handler,     /*  64: IRQ  48  ADC1 Sequence 2 */
    [INT_ADC1SS3]    = ADC1SS3_Handler,     /*  65: IRQ  49  ADC1 Sequence 3 */
    [INT_EPI0]       = EPI0_Handler,        /*  66: IRQ  50  EPI 0 */
    [INT_GPIOJ]      = GPIOJ_Handler,       /*  67: IRQ  51  GPIO Port J */
    [INT_GPIOK]      = GPIOK_Handler,       /*  68: IRQ  52  GPIO Port K */
    [INT_GPIOL]      = GPIOL_Handler,       /*  69: IRQ  53  GPIO Port L */
    [INT_SSI2]       = SSI2_Handler,        /*  70: IRQ  54  SSI 2 */
    [INT_SSI3]       = SSI3_Handler,        /*  71: IRQ  55  SSI 3 */
    [INT_UART3]      = UART3_Handler,       /*  72: IRQ  56  UART 3 */
    [INT_UART4]      = UART4_Handler,       /*  73: IRQ  57  UART 4 */
    [INT_UART5]      = UART5_Handler,       /*  74: IRQ  58  UART 5 */
    [INT_UART6]      = UART6_Handler,       /*  75: IRQ  59  UART 6 */
    [INT_UART7]      = UART7_Handler,       /*  76: IRQ  60  UART 7 */
    [INT_I2C2]       = I2C2_Handler,        /*  77: IRQ  61  I2C 2 */
    [INT_I2C3]       = I2C3_Handler,        /*  78: IRQ  62  I2C 3 */
    [INT_TIMER4A]    = TIMER4A_Handler,     /*  79: IRQ  63  Timer 4A */
    [INT_TIMER4B]    = TIMER4B_Handler,     /*  80: IRQ  64  Timer 4B */
    [INT_TIMER5A]    = TIMER5A_Handler,     /*  81: IRQ  65  Timer 5A */
    [INT_TIMER5B]    = TIMER5B_Handler,     /*  82: IRQ  66  Timer 5B */
    [INT_SYSEXC]     = SYSEXC_Handler,      /*  83: IRQ  67  Floating-Point Exception */
    [INT_I2C4]       = I2C4_Handler,        /*  86: IRQ  70  I2C 4 */
    [INT_I2C5]       = I2C5_Handler,        /*  87: IRQ  71  I2C 5 */
    [INT_GPIOM]      = GPIOM_Handler,       /*  88: IRQ  72  GPIO Port M */
    [INT_GPION]      = GPION_Handler,       /*  89: IRQ  73  GPIO Port N */
    [INT_TAMPER0]    = TAMPER0_Handler,     /*  91: IRQ  75  Tamper */
    [INT_GPIOP0]     = GPIOP0_Handler,      /*  92: IRQ  76  GPIO Port P (Summary or P0) */
    [INT_GPIOP1]     = GPIOP1_Handler,      /*  93: IRQ  77  GPIO Port P1 */
    [INT_GPIOP2]     = GPIOP2_Handler,      /*  94: IRQ  78  GPIO Port P2 */
    [INT_GPIOP3]     = GPIOP3_Handler,      /*  95: IRQ  79  GPIO Port P3 */
    [INT_GPIOP4]     = GPIOP4_Handler,      /*  96: IRQ  80  GPIO Port P4 */
    [INT_GPIOP5]     = GPIOP5_Handler,      /*  97: IRQ  81  GPIO Port P5 */
    [INT_GPIOP6]     = GPIOP6_Handler,      /*  98: IRQ  82  GPIO Port P6 */
    [INT_GPIOP7]     = GPIOP7_Handler,      /*  99: IRQ  83  GPIO Port P7 */
    [INT_GPIOQ0]     = GPIOQ0_Handler,      /* 100: IRQ  84  GPIO Port Q (Summary or Q0) */
    [INT_GPIOQ1]     = GPIOQ1_Handler,      /* 101: IRQ  85  GPIO Port Q1 */
    [INT_GPIOQ2]     = GPIOQ2_Handler,      /* 102: IRQ  86  GPIO Port Q2 */
    [INT_GPIOQ3]     = GPIOQ3_Handler,      /* 103: IRQ  87  GPIO Port Q3 */
    [INT_GPIOQ4]     = GPIOQ4_Handler,      /* 104: IRQ  88  GPIO Port Q4 */
    [INT_GPIOQ5]     = GPIOQ5_Handler,      /* 105: IRQ  89  GPIO Port Q5 */
    [INT_GPIOQ6]     = GPIOQ6_Handler,      /* 106: IRQ  90  GPIO Port Q6 */
    [INT_GPIOQ7]     = GPIOQ7_Handler,      /* 107: IRQ  91  GPIO Port Q7 */
    [INT_TIMER6A]    = TIMER6A_Handler,     /* 114: IRQ  98  16/32-Bit Timer 6A */
    [INT_TIMER6B]    = TIMER6B_Handler,     /* 115: IRQ  99  16/32-Bit Timer 6B */
    [INT_TIMER7A]    = TIMER7A_Handler,     /* 116: IRQ 100  16/32-Bit Timer 7A */
    [INT_TIMER7B]    = TIMER7B_Handler,     /* 117: IRQ 101  16/32-Bit Timer 7B */
    [INT_I2C6]       = I2C6_Handler,        /* 118: IRQ 102  I2C 6 */
    [INT_I2C7]       = I2C7_Handler,        /* 119: IRQ 103  I2C 7 */
    [INT_I2C8]       = I2C8_Handler,        /* 125: IRQ 109  I2C 8 */
    [INT_I2C9]       = I2C9_Handler,        /* 126: IRQ 110  I2C 9 */
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
