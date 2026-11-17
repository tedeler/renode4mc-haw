/*
 * tm4c1294.cmd - linker script for TI Arm Clang (tiarmclang) and the TM4C1294NCPDT
 *
 * Our own script (not a TI original). Memory:
 *   FLASH 1 MB from 0x00000000, SRAM 256 KB from 0x20000000
 * The vector table (.intvecs) is at the start of flash. The stack is placed after .bss/.data.
 */
--retain=g_pfnVectors

MEMORY
{
    FLASH (RX) : origin = 0x00000000, length = 0x00100000
    SRAM  (RWX): origin = 0x20000000, length = 0x00040000
}

/* Stack size 2 KB: must match the linker option --stack_size=2048. */
__STACK_SIZE = 2048;

SECTIONS
{
    .intvecs : > 0x00000000
    .text    : > FLASH
    .const   : > FLASH
    .rodata  : > FLASH
    .cinit   : > FLASH
    .pinit   : > FLASH
    .init_array : > FLASH

    .vtable  : > 0x20000000
    .data    : > SRAM
    .bss     : > SRAM
    .sysmem  : > SRAM
    .stack   : > SRAM (HIGH)
}

__STACK_TOP = __stack + __STACK_SIZE;
