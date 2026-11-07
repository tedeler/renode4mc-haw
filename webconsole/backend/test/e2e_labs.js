#!/usr/bin/env node
'use strict';
/**
 * Ende-zu-Ende-Test der vier Lab-Umgebungen (lab1_gpio .. lab4_uart) mit echter Renode-Instanz
 * und den Beispielen examples/lab01..lab04. Prüft über dieselben Schnittstellen wie das Frontend
 * (HTTP + beide WebSockets): Keypad, BCD-Anzeige, printf-Konsole, HC-SR04, LED-Pendel (Bild an der
 * richtigen Stelle im Schwung links -> rechts), UART 9600 7N1, LEDs, SW1-Interrupt und die
 * Diagnose (keine Meldung bei korrekter Firmware, Meldung bei absichtlich falscher).
 *
 *   node test/e2e_labs.js <Verzeichnis mit lab01.out, lab02.out, lab03.out, lab04.out> [http://localhost:3000]
 *
 * Optional im selben Verzeichnis (Fehlkonfiguration, Diagnose muss sie melden):
 *   lab01_ohne_den.out   PM4..PM7 ohne GPIODEN          lab01_ohne_wait.out  keypad_scan ohne wait()
 *   lab04_115200.out     UART mit 115200 8N1             lab04_ohne_pur.out   PJ0 ohne Pull-up
 *
 * Voraussetzung: Backend läuft (npm start bzw. Docker-Container).
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const dir = process.argv[2];
const base = (process.argv[3] || 'http://localhost:3000').replace(/\/$/, '');
const host = new URL(base).hostname;
if (!dir || !fs.existsSync(dir)) {
  console.error('Aufruf: node test/e2e_labs.js <Verzeichnis mit lab01.out ... lab04.out> [http://localhost:3000]');
  process.exit(2);
}
const file = (n) => {
  for (const ext of ['.out', '.elf']) if (fs.existsSync(path.join(dir, n + ext))) return path.join(dir, n + ext);
  return null;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
async function waitFor(fn, timeoutMs = 6000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

/** Startet einen Versuch mit Firmware und verbindet beide WebSockets. */
async function session(experiment, elf) {
  const fd = new FormData();
  fd.append('experiment_id', experiment);
  fd.append('file', new Blob([fs.readFileSync(elf)]), path.basename(elf));
  const res = await fetch(`${base}/upload`, { method: 'POST', body: fd });
  const body = await res.json();
  check(`${experiment}: Start mit ${path.basename(elf)}`, res.status === 200, body.error || '');
  if (res.status !== 200) throw new Error(body.error);

  const s = { uart: Buffer.alloc(0), cio: '', leds: {}, bcd: null, pd: null, diag: [], errors: [] };
  s.u = new WebSocket(`ws://${host}:3333`);
  s.u.on('message', (d) => (s.uart = Buffer.concat([s.uart, Buffer.from(d)])));
  s.c = new WebSocket(`ws://${host}:3334`);
  s.c.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'hello') {
      Object.assign(s.leds, m.leds || {});
      s.cio = Buffer.from(m.cio || '', 'base64').toString();
      s.diag = m.diagnostics || [];
      s.bcd = m.bcd;
    }
    if (m.type === 'leds') Object.assign(s.leds, m.states);
    if (m.type === 'cio') s.cio += Buffer.from(m.data, 'base64').toString();
    if (m.type === 'bcd') s.bcd = m;
    if (m.type === 'pd') s.pd = m;
    if (m.type === 'diag') s.diag.push(m);
    if (m.type === 'diagReset') s.diag = [];
    if (m.type === 'error') s.errors.push(m.message);
  });
  await Promise.all([s.u, s.c].map((ws) => new Promise((r) => ws.once('open', r))));
  s.send = (m) => s.c.send(JSON.stringify(m));
  s.close = () => {
    s.u.close();
    s.c.close();
  };
  s.diagText = () => s.diag.map((d) => d.message).join(' | ');
  return s;
}

// ---- Pendel: erwartetes Bild (wie examples/lab02_led_pendel und lab03_nvic_pendel) -------------
const FONT = {
  0: [0x3e, 0x51, 0x49, 0x45, 0x3e], 1: [0x00, 0x42, 0x7f, 0x40, 0x00], 2: [0x42, 0x61, 0x51, 0x49, 0x46],
  3: [0x21, 0x41, 0x45, 0x4b, 0x31], 4: [0x18, 0x14, 0x12, 0x7f, 0x10], 5: [0x27, 0x45, 0x45, 0x45, 0x39],
  6: [0x3c, 0x4a, 0x49, 0x49, 0x30], 7: [0x01, 0x71, 0x09, 0x05, 0x03], 8: [0x36, 0x49, 0x49, 0x49, 0x36],
  9: [0x06, 0x49, 0x49, 0x29, 0x1e], c: [0x38, 0x44, 0x44, 0x44, 0x20], m: [0x7c, 0x04, 0x18, 0x04, 0x78],
};
const SPALTEN = 40;

function expectedColumns(text) {
  const cols = new Array(SPALTEN).fill(0);
  let x = Math.floor((SPALTEN - (text.length * 6 - 1)) / 2);
  for (const ch of text) {
    for (const b of FONT[ch]) cols[x++] = b;
    x++;
  }
  return cols;
}

/**
 * Vergleicht das Nachleuchtbild des Modells (Schwung links -> rechts). Das Modell zählt LED 0 an der
 * Spitze; beim HAW-Pendel ist das PM7, die Firmware spiegelt den Zeichensatz -> Bit n = Zeile n.
 * Spalte k der Firmware liegt bei x = -0,8 + 1,6 * k / 39.
 */
function imageScore(pd, text) {
  const img = Buffer.from(pd.data, 'base64');
  const n = pd.columns;
  const at = (x) => img[Math.max(0, Math.min(n - 1, Math.floor(((x + 1) / 2) * n)))];
  const want = expectedColumns(text);
  let ok = 0;
  const bad = [];
  for (let k = 0; k < SPALTEN; k++) {
    const x = -0.8 + (1.6 * k) / 39;
    if (at(x) === want[k]) ok++;
    else bad.push(`${k}:${at(x).toString(16)}≠${want[k].toString(16)}`);
  }
  return { ok, bad, bars: at(-0.96) === 0xff && at(0.96) === 0xff };
}

/** Wartet (virtuelle Zeit kann langsamer laufen als die Uhr), bis das Bild stimmt. */
async function checkImage(s, text, what) {
  let r = { ok: 0, bad: [], bars: false };
  await waitFor(() => {
    if (!s.pd) return false;
    r = imageScore(s.pd, text);
    return r.ok === SPALTEN && r.bars;
  }, 10000);
  check(`${what}: "${text}" im Schwung links→rechts`, r.ok === SPALTEN, `${r.ok}/${SPALTEN} ${r.bad.slice(0, 4).join(' ')}`);
  check(`${what}: Balken am linken und rechten Rand`, r.bars);
}

async function lab1() {
  const elf = file('lab01');
  if (!elf) return console.log('-- lab01 fehlt, Lab 1 übersprungen');
  const s = await session('lab1_gpio', elf);
  check('Lab 1: printf-Startmeldung in der CCS-Konsole', await waitFor(() => /Lab 1: Hex-Keypad/.test(s.cio)));
  s.send({ type: 'keypad', row: 1, col: 1, pressed: true });                  // Y2/X2 = "5"
  check('Lab 1: Taste 5 -> printf', await waitFor(() => /Taste 5\n/.test(s.cio)));
  check('Lab 1: Taste 5 -> BCD-Anzeige 0005', await waitFor(() => s.bcd && s.bcd.digits === '0005'));
  await sleep(300);
  check('Lab 1: Anforderung 1 – nur einmal ausgegeben', (s.cio.match(/Taste 5/g) || []).length === 1);
  s.send({ type: 'keypad', row: 1, col: 1, pressed: false });
  await sleep(200);
  s.send({ type: 'keypad', row: 3, col: 3, pressed: true });                  // Y4/X4 = "C"
  check('Lab 1: Taste C -> BCD-Anzeige 005C', await waitFor(() => s.bcd && s.bcd.digits === '005C'));
  s.send({ type: 'keypad', row: 0, col: 3, pressed: true });                  // dazu "F"
  check('Lab 1: Anforderung 2 – zwei Tasten -> Fehlermeldung', await waitFor(() => /Fehler: mehrere Tasten/.test(s.cio)));
  s.send({ type: 'keypad', row: 0, col: 3, pressed: false });
  s.send({ type: 'keypad', row: 3, col: 3, pressed: false });
  await sleep(300);
  check('Lab 1: Diagnose ohne Meldung (Firmware korrekt)', s.diag.length === 0, s.diagText());
  check('Lab 1: keine Fehler vom Backend', s.errors.length === 0, s.errors.join('; '));
  s.close();

  const noDen = file('lab01_ohne_den');
  if (noDen) {
    const t = await session('lab1_gpio', noDen);
    check('Strenge: PM4 ohne DEN wird gemeldet', await waitFor(() => /PM4 wird als Eingang gelesen, aber GPIODEN = 0/.test(t.diagText())), t.diagText());
    t.close();
  }
  const noWait = file('lab01_ohne_wait');
  if (noWait) {
    const t = await session('lab1_gpio', noWait);
    await sleep(500);
    t.send({ type: 'keypad', row: 1, col: 1, pressed: true });
    check('Strenge: ohne wait() erkennt das Programm falsche Tasten (Laufzeitverzögerung)',
      await waitFor(() => /Fehler: mehrere|Taste [^5]/.test(t.cio)), JSON.stringify(t.cio.slice(-60)));
    t.close();
  }
}

async function pendel(experiment, name, what, outOfRange) {
  const elf = file(name);
  if (!elf) return console.log(`-- ${name} fehlt, ${what} übersprungen`);
  const s = await session(experiment, elf);
  check(`${what}: printf-Startmeldung`, await waitFor(() => /Lab [23]/.test(s.cio)));
  check(`${what}: Startwert 65 cm gemessen`, await waitFor(() => /Abstand: 65 cm/.test(s.cio)));
  for (const cm of [42, 123]) {
    s.send({ type: 'sensor', value: cm });
    check(`${what}: HC-SR04 ${cm} cm -> printf`, await waitFor(() => new RegExp(`Abstand: ${cm} cm`).test(s.cio)));
    await checkImage(s, `${cm}cm`, what);
  }
  s.send({ type: 'sensor', value: 330 });
  check(`${what}: außerhalb 300 cm -> Meldung`, await waitFor(() => outOfRange.test(s.cio)));
  s.send({ type: 'pendulum', frequency: 5 });
  s.send({ type: 'sensor', value: 7 });
  check(`${what}: 5 Hz, 7 cm -> printf`, await waitFor(() => /Abstand: 7 cm/.test(s.cio)));
  await checkImage(s, '7cm', `${what} bei 5 Hz`);
  check(`${what}: Diagnose ohne Meldung (Firmware korrekt)`, s.diag.length === 0, s.diagText());
  check(`${what}: keine Fehler vom Backend`, s.errors.length === 0, s.errors.join('; '));
  s.close();
}

async function lab4() {
  const elf = file('lab04');
  if (!elf) return console.log('-- lab04 fehlt, Lab 4 übersprungen');
  const s = await session('lab4_uart', elf);
  const text = () => s.uart.toString('latin1');
  check('Lab 4: Prompt ">" per UART', await waitFor(() => text().includes('>')));
  s.u.send('leds +1+3\r');
  check('Lab 4: "leds +1+3" -> D1 und D3 an', await waitFor(() => s.leds.D1 && s.leds.D3 && !s.leds.D2 && !s.leds.D4), JSON.stringify(s.leds));
  check('Lab 4: Befehl mit printf in der CCS-Konsole', await waitFor(() => /leds \+1\+3\n/.test(s.cio)));
  s.send({ type: 'button', id: 'SW1', pressed: true });
  await sleep(100);
  s.send({ type: 'button', id: 'SW1', pressed: false });
  check('Lab 4: SW1 loslassen -> "#13<CR>"', await waitFor(() => text().includes('#13\r')), JSON.stringify(text().slice(-20)));
  s.u.send('leds ~1-3+4~2\r');
  check('Lab 4: "leds ~1-3+4~2" -> D2 und D4 an', await waitFor(() => !s.leds.D1 && s.leds.D2 && !s.leds.D3 && s.leds.D4), JSON.stringify(s.leds));
  s.u.send('leds +1x3\r');
  check('Lab 4: Syntaxfehler -> Abbruch ab der Fehlerstelle (D1 an, sonst gleich)',
    await waitFor(() => s.leds.D1 && s.leds.D2 && s.leds.D4 && /Syntaxfehler/.test(s.cio)), JSON.stringify(s.leds));
  check('Lab 4: Diagnose ohne Meldung (Firmware korrekt)', s.diag.length === 0, s.diagText());
  s.close();

  const wrongBaud = file('lab04_115200');
  if (wrongBaud) {
    const t = await session('lab4_uart', wrongBaud);
    await waitFor(() => t.uart.length > 0, 3000);
    check('Strenge: falsche Baudrate -> Zeichensalat statt ">"', t.uart.length > 0 && !t.uart.includes(0x3e) && t.uart[0] >= 0x80, t.uart.toString('hex'));
    check('Strenge: falsche Baudrate wird gemeldet', await waitFor(() => /11\d{4} Baud 8N1.*erwartet 9600 Baud 7N1/.test(t.diagText())), t.diagText());
    t.close();
  }
  const noPur = file('lab04_ohne_pur');
  if (noPur) {
    const t = await session('lab4_uart', noPur);
    await sleep(300);
    t.send({ type: 'button', id: 'SW1', pressed: true });
    await sleep(100);
    t.send({ type: 'button', id: 'SW1', pressed: false });
    check('Strenge: SW1 ohne Pull-up -> kein Interrupt beim Loslassen', !(await waitFor(() => t.uart.includes(0x23), 1500)));
    check('Strenge: offener Eingang PJ0 wird gemeldet', await waitFor(() => /PJ0 ist ein offener Eingang/.test(t.diagText())), t.diagText());
    t.close();
  }
}

/** Musterlösung über POST /api/solution starten (wie der Knopf in der Web-Konsole) */
async function solutions() {
  const list = await (await fetch(`${base}/api/experiments`)).json();
  for (const [id, re] of [['lab1_gpio', /Lab 1:/], ['lab2_pendel', /Lab 2:/], ['lab3_nvic', /Lab 3 \(NVIC\)/], ['lab4_uart', null]]) {
    const info = list.find((x) => x.id === id);
    check(`${id}: Musterlösung angeboten und gebaut`, !!(info && info.solution && info.solution.available), JSON.stringify(info && info.solution));
    const res = await fetch(`${base}/api/solution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ experiment_id: id }),
    });
    const body = await res.json();
    check(`${id}: POST /api/solution -> 200`, res.status === 200 && body.solution === true, body.error || '');
    const st = await (await fetch(`${base}/api/status`)).json();
    check(`${id}: Status meldet Musterlösung`, st.running && st.solution === true);
    const c = new WebSocket(`ws://${host}:3334`);
    const u = new WebSocket(`ws://${host}:3333`);
    let cio = '';
    let uart = '';
    c.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'hello') cio = Buffer.from(m.cio || '', 'base64').toString();
      if (m.type === 'cio') cio += Buffer.from(m.data, 'base64').toString();
    });
    u.on('message', (d) => (uart += d.toString('latin1')));
    if (re) check(`${id}: Musterlösung läuft (printf)`, await waitFor(() => re.test(cio)));
    else check(`${id}: Musterlösung läuft (Prompt ">")`, await waitFor(() => uart.includes('>')));
    c.close();
    u.close();
  }
}

// ONLY=lab1,lab4 node test/e2e_labs.js ...  -> nur diese Labs
const only = (process.env.ONLY || 'lab1,lab2,lab3,lab4,solution').split(',');

(async () => {
  if (only.includes('lab1')) await lab1();
  if (only.includes('lab2')) await pendel('lab2_pendel', 'lab02', 'Lab 2', /kein Echo/);
  if (only.includes('lab3')) await pendel('lab3_nvic', 'lab03', 'Lab 3', /kein Objekt/);
  if (only.includes('lab4')) await lab4();
  if (only.includes('solution')) await solutions();
  console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
