/* TI Linker Command File für TM4C1294 */

/* Schützt die Vektortabelle davor, vom Linker wegoptimiert zu werden */
--retain="*(.intvecs)"

MEMORY
{
    FLASH : origin = 0x00000000, length = 0x00100000
    SRAM  : origin = 0x20000000, length = 0x00040000
}

/* Hardcodierte Berechnung der Stack-Spitze (0x20000000 + 256KB) */
__stack_top = 0x20040000;

SECTIONS
{
    /* Vektortabelle zwingend an Adresse 0x0 ablegen */
    .intvecs : > 0x00000000

    .text    : > FLASH
    .const   : > FLASH
    .rodata  : > FLASH
    .cinit   : > FLASH
    .pinit   : > FLASH

    .data    : > SRAM
    .bss     : > SRAM
    .sysmem  : > SRAM
    .stack   : > SRAM
}
