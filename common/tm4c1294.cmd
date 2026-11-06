/*
 * tm4c1294.cmd - Linker-Skript für TI Arm Clang (tiarmclang) und den TM4C1294NCPDT
 *
 * Eigenes Skript (kein TI-Original). Speicher:
 *   FLASH 1 MB ab 0x00000000, SRAM 256 KB ab 0x20000000
 * Die Vektortabelle (.intvecs) liegt am Flash-Anfang. Der Stack liegt am Ende von .bss/.data.
 */
--retain=g_pfnVectors

MEMORY
{
    FLASH (RX) : origin = 0x00000000, length = 0x00100000
    SRAM  (RWX): origin = 0x20000000, length = 0x00040000
}

/* Stackgröße 2 KB: muss zur Linker-Option --stack_size=2048 passen. */
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
