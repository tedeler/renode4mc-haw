/*
 * cpu_clang.c - Ersatz für TivaWare driverlib/cpu.c
 *
 * Die TivaWare-Datei cpu.c enthält Assembler-Funktionen, die TI Arm Clang (tiarmclang)
 * nicht übersetzen kann. Diese Datei stellt dieselben Funktionen (gleiche Namen und
 * Bedeutung) mit Inline-Assembler bereit, den tiarmclang versteht.
 */
#include <stdint.h>
#include "driverlib/cpu.h"

uint32_t CPUcpsid(void)
{
    uint32_t primask;
    __asm volatile("mrs %0, primask\n cpsid i" : "=r"(primask) :: "memory");
    return primask;
}

uint32_t CPUprimask(void)
{
    uint32_t primask;
    __asm volatile("mrs %0, primask" : "=r"(primask));
    return primask;
}

uint32_t CPUcpsie(void)
{
    uint32_t primask;
    __asm volatile("mrs %0, primask\n cpsie i" : "=r"(primask) :: "memory");
    return primask;
}

void CPUwfi(void)
{
    __asm volatile("wfi");
}

uint32_t CPUbasepriGet(void)
{
    uint32_t basepri;
    __asm volatile("mrs %0, basepri" : "=r"(basepri));
    return basepri;
}

void CPUbasepriSet(uint32_t ui32NewBasepri)
{
    __asm volatile("msr basepri, %0" :: "r"(ui32NewBasepri) : "memory");
}
