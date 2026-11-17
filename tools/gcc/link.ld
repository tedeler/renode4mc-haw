/* Linker script for the gcc builds of the reference solutions (tools/build-solutions.sh), equivalent to
 * common/tm4c1294.cmd: flash 1 MB from 0x0, SRAM 256 KB from 0x20000000, stack at the end of SRAM. */
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
