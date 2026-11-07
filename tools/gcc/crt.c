/* Ersatz für _c_int00 des TI-Laufzeitsystems (nur für die gcc-Builds der Musterlösungen):
 * .data aus dem Flash kopieren, .bss löschen, main() aufrufen. */
#include <stdint.h>
extern uint32_t _etext, _data, _edata, _bss, _ebss;
extern int main(void);
void _c_int00(void) {
    uint32_t *s = &_etext, *d = &_data;
    while (d < &_edata) *d++ = *s++;
    for (d = &_bss; d < &_ebss; ) *d++ = 0;
    main();
    for (;;) {}
}
