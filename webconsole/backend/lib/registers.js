'use strict';

/**
 * Peripherie-Register für die Simulations-Anzeige, aus der TI-Headerdatei tm4c1294ncpdt.h
 * (dieselben Namen wie im Code der Studierenden, z. B. UART0_FR_R).
 *
 * Angezeigt werden nur Module, die der Simulator modelliert: SYSCTL, GPIO A–Q, UART0–7, TIMER0–7,
 * I2C0–9 (nur Master-Register), NVIC und SysTick. Gelesen wird in Renode mit
 * "sysbus.sysctl PeekRegisters" ohne Nebenwirkung (kein Zeichen aus dem FIFO, keine Warnung bei
 * fehlendem Takt).
 */
const fs = require('fs');

const REG_RE = /^#define\s+(\w+)_R\s+\(\*\(\(volatile uint32_t \*\)0x([0-9A-Fa-f]{8})\)\)/;
const INT_RE = /^#define\s+(INT_\w+)\s+(\d+)\b/;
// Ausnahmen 1–15 des Cortex-M4 (stehen nicht im Header)
const EXCEPTIONS = { 1: 'Reset', 2: 'NMI', 3: 'HardFault', 4: 'MemManage', 5: 'BusFault', 6: 'UsageFault', 11: 'SVCall', 12: 'DebugMon', 14: 'PendSV', 15: 'SysTick' };

// Name -> Modul; null = nicht anzeigen
function moduleOf(name) {
  let m;
  if ((m = /^GPIO_PORT([A-Q])(?:_AHB)?_(\w+)$/.exec(name))) return `GPIO ${m[1]}`;
  if ((m = /^UART(\d)_\w+$/.exec(name))) return `UART${m[1]}`;
  if ((m = /^TIMER(\d)_\w+$/.exec(name))) return `TIMER${m[1]}`;
  if ((m = /^I2C(\d)_(M\w+|PP|PC)$/.exec(name))) return `I2C${m[1]}`;
  if (/^NVIC_ST_(CTRL|RELOAD)$/.test(name)) return 'SysTick'; // CURRENT nur vom CPU-Thread lesbar
  if (/^NVIC_(EN|DIS|PEND|UNPEND|ACTIVE)\d$|^NVIC_PRI\d+$|^NVIC_(INT_CTRL|VTABLE|APINT|SYS_CTRL|CFG_CTRL|SYS_PRI[123]|SYS_HND_CTRL|FAULT_STAT|HFAULT_STAT|MM_ADDR|FAULT_ADDR)$/.test(name)) {
    return 'NVIC';
  }
  if (/^SYSCTL_\w+$/.test(name)) return 'SYSCTL';
  return null;
}

/**
 * Liest die Headerdatei: { modules: [name, ...], byModule: { name: [{ name, addr }] },
 * vectors: { Nummer: Name } } – Vektoren ab 16 als INT_xxx aus dem Header, 1–15 Cortex-M
 */
function load(headerPath) {
  const byModule = {};
  const vectors = { ...EXCEPTIONS };
  let text;
  try {
    text = fs.readFileSync(headerPath, 'latin1');
  } catch (e) {
    console.error(`[registers] Headerdatei nicht lesbar (${headerPath}): ${e.message}`);
    return { modules: [], byModule, vectors };
  }
  for (const line of text.split(/\r?\n/)) {
    const iv = INT_RE.exec(line);
    if (iv && Number(iv[2]) >= 16 && !vectors[iv[2]]) vectors[iv[2]] = iv[1];
    const m = REG_RE.exec(line);
    if (!m) continue;
    const mod = moduleOf(m[1]);
    if (!mod) continue;
    (byModule[mod] = byModule[mod] || []).push({ name: `${m[1]}_R`, addr: parseInt(m[2], 16) });
  }
  for (const list of Object.values(byModule)) list.sort((a, b) => a.addr - b.addr);
  const order = (n) => {
    const k = ['SYSCTL', 'NVIC', 'SysTick', 'GPIO', 'UART', 'TIMER', 'I2C'].findIndex((p) => n.startsWith(p));
    return `${k}${n.replace(/\d+$/, (d) => d.padStart(2, '0'))}`;
  };
  const modules = Object.keys(byModule).sort((a, b) => order(a).localeCompare(order(b)));
  return { modules, byModule, vectors };
}

module.exports = { load };
