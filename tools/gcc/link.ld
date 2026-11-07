/* Linker-Skript für die gcc-Builds der Musterlösungen (tools/build-solutions.sh), entspricht
 * common/tm4c1294.cmd: Flash 1 MB ab 0x0, SRAM 256 KB ab 0x20000000, Stack am Ende des SRAM. */
MEMORY { FLASH (rx) : ORIGIN = 0x0, LENGTH = 1024K  SRAM (rwx) : ORIGIN = 0x20000000, LENGTH = 256K }
SECTIONS {
  .text : { KEEP(*(.intvecs)) *(.text*) *(.rodata*) . = ALIGN(4); } > FLASH
  .ARM.exidx : { *(.ARM.exidx*) } > FLASH
  _etext = .;
  .data : AT(_etext) { _data = .; *(.data*) . = ALIGN(4); _edata = .; } > SRAM
  .bss (NOLOAD) : { _bss = .; *(.bss*) *(COMMON) . = ALIGN(4); _ebss = .; } > SRAM
  end = .; _end = .;
  __STACK_TOP = ORIGIN(SRAM) + LENGTH(SRAM);
}
