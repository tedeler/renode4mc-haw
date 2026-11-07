/* printf() für gcc (newlib) über das CIO-Protokoll des TI-Laufzeitsystems (trgmsg.c / hostwrite.c):
 * Die gcc-Builds erzeugen damit genau die Nachrichten, die CCS-Programme an C$$IO$$ senden, und
 * ihre Ausgabe erscheint im Simulator in der CCS-Konsole (sim/models/TiCioConsole.cs). */
#include <stdint.h>
#include <sys/stat.h>
#include <errno.h>
volatile unsigned char _CIOBUF_[256 + 32] __attribute__((used));
static void writemsg(unsigned char cmd, const unsigned char *parm, const char *data, unsigned len) {
    volatile unsigned char *p = _CIOBUF_;
    *(volatile unsigned int *)p = len; p += 4;
    *p++ = cmd;
    for (int i = 0; i < 8; i++) *p++ = parm[i];
    for (unsigned i = 0; i < len; i++) *p++ = data[i];
    __asm volatile(".global C$$IO$$\nC$$IO$$: nop" ::: "memory");
}
static unsigned readmsg(unsigned char *parm) {
    volatile unsigned char *p = _CIOBUF_;
    unsigned len = *(volatile unsigned int *)p; p += 4;
    for (int i = 0; i < 8; i++) parm[i] = p[i];
    return len;
}
int _write(int fd, const char *buf, int count) {
    unsigned char parm[8] = {0};
    if (count > 256) count = 256;
    parm[0] = fd; parm[1] = fd >> 8; parm[2] = count; parm[3] = count >> 8;
    writemsg(0xF3, parm, buf, count);
    readmsg(parm);
    return (short)(parm[0] | (parm[1] << 8));
}
int _read(int fd, char *b, int n) { (void)fd; (void)b; (void)n; return 0; }
int _close(int fd) { (void)fd; return -1; }
int _lseek(int fd, int o, int w) { (void)fd; (void)o; (void)w; return 0; }
int _fstat(int fd, struct stat *st) { (void)fd; st->st_mode = S_IFCHR; return 0; }
int _isatty(int fd) { (void)fd; return 1; }
extern char end;
static char *brk_ = &end;
void *_sbrk(int inc) { char *o = brk_; brk_ += inc; return o; }
void _exit(int c) { (void)c; for (;;) {} }
int _kill(int p, int s) { (void)p; (void)s; errno = EINVAL; return -1; }
int _getpid(void) { return 1; }
