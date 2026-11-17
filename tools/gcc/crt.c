/* Replacement for _c_int00 of the TI run-time library (only for the gcc builds of the reference solutions):
 * copy .data from flash, clear .bss, call main(). */
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
