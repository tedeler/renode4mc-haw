'use strict';

/**
 * Versuchsbeschreibung in EINER JSON-Datei: sim/experiments/<id>.json
 *
 * Die Datei zählt die Bedienelemente (GUI-Elemente) des Versuchs auf und legt für jedes fest, an welchen
 * Pins des TM4C1294 es hängt. Daraus erzeugt dieses Modul
 *   - die Renode-Plattformerweiterung (.repl: Geräte und Verdrahtung),
 *   - das Renode-Startskript (.resc) und
 *   - die interne Konfiguration für Backend und Frontend (Renode-Pfade, Widget-Einstellungen).
 *
 * Benutzt vom Backend (lib/experiments.js) und vom Prüfwerkzeug tools/check_experiment.js.
 * Format und Beispiele: docs/EXPERIMENTS.md
 *
 * build(spec, id) -> { errors: [], warnings: [], config, repl, resc(replPath) }
 *   errors   nicht leer -> Versuch ist ungültig (wird nicht angezeigt)
 *   warnings Hinweise (Versuch läuft trotzdem)
 */

// ---------------------------------------------------------------------------------------------
// Chip und Board
// ---------------------------------------------------------------------------------------------

/** GPIO-Pins des TM4C1294NCPDT (128-TQFP, 90 GPIOs): Port -> Anzahl Pins (0..n-1) */
const PORT_PINS = { A: 8, B: 6, C: 8, D: 8, E: 6, F: 5, G: 2, H: 4, J: 2, K: 8, L: 8, M: 8, N: 6, P: 6, Q: 5 };
const PIN_RE = /^P([A-HJ-NPQ])([0-7])$/;

/**
 * UART-Pins laut Datenblatt Tabelle 10-2 (128-TQFP), alle mit GPIOPCTL-Funktion 1:
 * Pin -> UART-Nummer. TX und RX müssen zum selben UART gehören, dürfen aber an verschiedenen Ports liegen.
 */
const UART_RX_PINS = { PA0: 0, PB0: 1, PQ4: 1, PA6: 2, PD4: 2, PA4: 3, PJ0: 3, PA2: 4, PK0: 4, PC6: 5, PP0: 6, PC4: 7 };
const UART_TX_PINS = { PA1: 0, PB1: 1, PA7: 2, PD5: 2, PA5: 3, PJ1: 3, PA3: 4, PK1: 4, PC7: 5, PP1: 6, PC5: 7 };
const UART_PIN_FUNCTION = 1;

/** Fest belegte Pins: dürfen nicht verwendet werden */
const RESERVED_PINS = {
  PC0: 'JTAG/SWD TCK (debugger)',
  PC1: 'JTAG/SWD TMS (debugger)',
  PC2: 'JTAG TDI (debugger)',
  PC3: 'JTAG TDO/SWO (debugger)',
};

/** I2C-Pins der Busse, die auf dem Board herausgeführt und im Simulator verdrahtet sind */
const I2C_PINS = { i2c0: ['PB2', 'PB3'] };

/** Pins, die auf dem EK-TM4C1294XL schon mit etwas verbunden sind (nur Hinweis) */
const BOARD_PINS = {
  PA0: 'the debug chip (virtual COM port, U0RX)',
  PA1: 'the debug chip (virtual COM port, U0TX)',
  PN1: 'LED D1',
  PN0: 'LED D2',
  PF4: 'LED D3',
  PF0: 'LED D4',
  PJ0: 'push button USR_SW1',
  PJ1: 'push button USR_SW2',
};

/** Geschützte Pins (GPIOLOCK/GPIOCR nötig, Datenblatt 10.3.4) – nur Hinweis */
const LOCKED_PINS = { PD7: 'NMI' };

const LED_BRIDGE = 'ws://127.0.0.1:9000'; // WebSocketBridge der Basisplattform, 8 Eingänge
const LED_BRIDGE_INPUTS = 8;
const UART_FORMAT_RE = /^[5-8][NOEMS][12]$/;
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ELEMENT_ID_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const COLOR_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
const I2C_BUS_RE = /^i2c[0-9]$/;

const HEX_LAYOUT = [
  ['1', '2', '3', 'F'],
  ['4', '5', '6', 'E'],
  ['7', '8', '9', 'D'],
  ['A', '0', 'B', 'C'],
];
const PHONE_LAYOUT = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['*', '0', '#'],
];

// ---------------------------------------------------------------------------------------------
// Feldprüfungen
// ---------------------------------------------------------------------------------------------

const F = {
  str: (v) => (typeof v === 'string' ? null : 'text expected'),
  bool: (v) => (typeof v === 'boolean' ? null : 'true or false expected'),
  num: (min, max) => (v) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? null : `number ${min}..${max} expected`),
  int: (min, max) => (v) => (Number.isInteger(v) && v >= min && v <= max ? null : `integer ${min}..${max} expected`),
  oneOf: (...opts) => (v) => (opts.includes(v) ? null : `allowed: ${opts.map((o) => JSON.stringify(o)).join(', ')}`),
  re: (re, hint) => (v) => (typeof v === 'string' && re.test(v) ? null : hint),
  pin: (v) => checkPinName(v),
  layout: (maxRows, maxCols) => (v) =>
    Array.isArray(v) && v.length >= 1 && v.length <= maxRows &&
    v.every((r) => Array.isArray(r) && r.length === v[0].length && r.length >= 1 && r.length <= maxCols &&
      r.every((k) => typeof k === 'string' && k.length >= 1 && k.length <= 4))
      ? null
      : `list of rows of equal length (max. ${maxRows} x ${maxCols}), keys as short text`,
  i2cAddress: (v) => (parseAddress(v) === null ? '7-bit I2C address, e.g. "0x3C" or 60' : null),
  object: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? null : 'object expected'),
};

function parseAddress(v) {
  let n = null;
  if (Number.isInteger(v)) n = v;
  else if (typeof v === 'string' && /^0x[0-9a-fA-F]{1,2}$/.test(v)) n = parseInt(v, 16);
  else if (typeof v === 'string' && /^[0-9]{1,3}$/.test(v)) n = parseInt(v, 10);
  return n !== null && n >= 0x08 && n <= 0x77 ? n : null;
}

function checkPinName(v) {
  if (typeof v !== 'string') return 'pin name like "PK0" expected';
  const m = PIN_RE.exec(v);
  if (!m) return `"${v}" is not a pin name (port A–H, J–N, P, Q, pin 0–7, e.g. "PK0")`;
  if (Number(m[2]) >= PORT_PINS[m[1]]) {
    return `${v} does not exist on the TM4C1294NCPDT (port ${m[1]} only has P${m[1]}0–P${m[1]}${PORT_PINS[m[1]] - 1})`;
  }
  return null;
}

function hex(n) {
  return `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// Katalog der Bedienelemente
// ---------------------------------------------------------------------------------------------
//
// Je Typ:
//   gui        Abschnitt der Web-Konsole (Widget), "leds"/"buttons" sind Listen, sonst höchstens eines
//   fields     erlaubte Felder (außer type, pins, labels) mit Prüfung; required = Pflicht
//   model      Renode-Gerät: { name, cls, cs } – Name im Renode-Baum, Klasse, Modelldatei in sim/models/
//   pins(el)   Liste der Anschlüsse: { key, dir, index | output, label }
//                dir "out": Ausgang der MCU treibt Eingang <index> des Geräts  (gpioX: n -> gerät@index)
//                dir "in":  Ausgang <output> des Geräts treibt den MCU-Eingang (gerät: output -> gpioX@n)
//                dir "ext": von außen getrieben (Taster, Monitor-Befehl), keine Verdrahtung
//   pinKeys    Pflicht-Pins (für Meldungen über fehlende/unbekannte Pins)
//   attrs(el)  Konstruktor-Parameter des Modells in der .repl
//   gui(el)    Einstellungen des Widgets (ohne Renode-Pfad)

const LABEL = { label: F.str, title: F.str };

const TYPES = {
  led: {
    gui: 'leds',
    list: true,
    desc: 'LED on an output (HIGH = on)',
    fields: { id: { check: F.re(ELEMENT_ID_RE, 'name like "D1"'), required: true }, label: F.str, color: F.re(COLOR_RE, 'colour like "#22c55e"'), pin: { check: F.pin, required: true } },
    pins: (el) => [{ key: 'pin', pin: el.pin, dir: 'out', label: `LED ${shortLabel(el)}` }],
  },

  button: {
    gui: 'buttons',
    list: true,
    desc: 'push button on an input (pressed: pin connected to GND or 3.3 V, released: open)',
    fields: {
      id: { check: F.re(ELEMENT_ID_RE, 'name like "SW1"'), required: true },
      label: F.str,
      pin: { check: F.pin, required: true },
      activeLow: F.bool,
      pull: F.oneOf('up', 'down', 'none'),
    },
    pins: (el) => [{ key: 'pin', pin: el.pin, dir: 'ext', label: shortLabel(el) }],
  },

  bcd: {
    gui: 'bcd',
    desc: '7-segment display with BCD inputs (HAW, 2 modules with 2 digits each, Lab 1)',
    fields: LABEL,
    model: { name: 'bcd', cls: 'Miscellaneous.BcdDisplay', cs: 'BcdDisplay.cs' },
    pinKeys: ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'EN_R', 'EN_L'],
    pins: () => [
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ key: `D${i}`, dir: 'out', index: i, label: `BCD D${i}` })),
      { key: 'EN_R', dir: 'out', index: 8, label: 'BCD EN right' },
      { key: 'EN_L', dir: 'out', index: 9, label: 'BCD EN left' },
    ],
    widget: (el) => pick(el, ['label']),
  },

  hexkeypad: {
    gui: 'keypad',
    desc: 'HAW hex keypad 4×4 (active LOW, rows with pull-up, Lab 1)',
    fields: { ...LABEL, layout: F.layout(4, 4), riseTimeUs: F.int(0, 100000) },
    model: { name: 'hexkeypad', cls: 'Miscellaneous.HexKeypad', cs: 'HexKeypad.cs' },
    pinKeys: ['X1', 'X2', 'X3', 'X4', 'Y1', 'Y2', 'Y3', 'Y4'],
    pins: () => [
      ...[1, 2, 3, 4].map((i) => ({ key: `X${i}`, dir: 'out', index: i - 1, label: `Keypad X${i} (column)` })),
      ...[1, 2, 3, 4].map((i) => ({ key: `Y${i}`, dir: 'in', output: `Y${i - 1}`, label: `Keypad Y${i} (row)` })),
    ],
    attrs: (el) => ({ riseTimeUs: el.riseTimeUs ?? 20 }),
    check: (el) => (el.layout && (el.layout.length !== 4 || el.layout[0].length !== 4) ? ['layout: the hex keypad has 4 × 4 keys'] : []),
    widget: (el, pins) => ({
      ...pick(el, ['title', 'label']),
      layout: el.layout || HEX_LAYOUT,
      rowPins: ['Y1', 'Y2', 'Y3', 'Y4'].map((k) => pins[k]),
      colPins: ['X1', 'X2', 'X3', 'X4'].map((k) => pins[k]),
      rowNames: ['Y1', 'Y2', 'Y3', 'Y4'],
      colNames: ['X1', 'X2', 'X3', 'X4'],
    }),
  },

  keypad: {
    gui: 'keypad',
    desc: 'key matrix (active HIGH): rows R0.. driven by outputs, columns C0.. to inputs (pull-down in the model)',
    fields: { ...LABEL, layout: F.layout(8, 4) },
    model: { name: 'keypad', cls: 'Miscellaneous.KeypadMatrix', cs: 'KeypadMatrix.cs' },
    pinKeys: (el) => {
      const [rows, cols] = matrixSize(el);
      return [...range(rows).map((r) => `R${r}`), ...range(cols).map((c) => `C${c}`)];
    },
    pins: (el) => {
      const [rows, cols] = matrixSize(el);
      return [
        ...range(rows).map((r) => ({ key: `R${r}`, dir: 'out', index: r, label: `Keypad row ${r}` })),
        ...range(cols).map((c) => ({ key: `C${c}`, dir: 'in', output: `Col${c}`, label: `Keypad column ${c}` })),
      ];
    },
    attrs: (el) => {
      const [rows, columns] = matrixSize(el);
      return { rows, columns };
    },
    widget: (el, pins) => {
      const [rows, cols] = matrixSize(el);
      return {
        ...pick(el, ['title', 'label']),
        rowPins: range(rows).map((r) => pins[`R${r}`]),
        colPins: range(cols).map((c) => pins[`C${c}`]),
        layout: el.layout || PHONE_LAYOUT,
      };
    },
  },

  pendulum: {
    gui: 'pendulum',
    desc: 'LED pendulum / pendulum display: 8 LEDs (LED0 = topmost, at the tip) and sync signal',
    fields: {
      label: F.str,
      frequency: F.num(0.05, 100),
      minFrequency: F.num(0.05, 100),
      maxFrequency: F.num(0.05, 100),
      afterglowMs: F.num(1, 1000),
      syncMode: F.oneOf('position', 'direction'),
      periodUs: F.int(10000, 20000000),
      columns: F.int(8, 1000),
    },
    model: { name: 'pendel', cls: 'Miscellaneous.PendulumDisplay', cs: 'PendulumDisplay.cs' },
    pinKeys: ['LED0', 'LED1', 'LED2', 'LED3', 'LED4', 'LED5', 'LED6', 'LED7', 'SYNC'],
    pins: () => [
      ...range(8).map((i) => ({ key: `LED${i}`, dir: 'out', index: i, label: `Pendulum LED ${i}${i === 0 ? ' (tip)' : ''}` })),
      { key: 'SYNC', dir: 'in', output: 'Sync', label: 'Pendulum sync' },
    ],
    attrs: (el) => ({
      periodUs: el.periodUs ?? Math.round(1e6 / (el.frequency ?? 10)),
      columns: el.columns ?? 120,
      ...(el.syncMode && el.syncMode !== 'position' ? { syncMode: el.syncMode } : {}),
    }),
    check: (el) => {
      const f = el.frequency ?? 10;
      const lo = el.minFrequency ?? f;
      const hi = el.maxFrequency ?? f;
      return lo <= f && f <= hi ? [] : ['minFrequency <= frequency <= maxFrequency (Hz)'];
    },
    widget: (el) => ({
      ...pick(el, ['label', 'afterglowMs']),
      frequency: el.frequency ?? 10,
      minFrequency: el.minFrequency ?? el.frequency ?? 10,
      maxFrequency: el.maxFrequency ?? el.frequency ?? 10,
    }),
  },

  hcsr04: {
    gui: 'sensor',
    desc: 'ultrasonic module HC-SR04 (trigger/echo, Lab 2/3)',
    fields: { ...LABEL, initial: F.int(0, 1000), min: F.int(0, 1000), max: F.int(1, 1000), unit: F.str },
    model: { name: 'hcsr04', cls: 'Sensors.HcSr04', cs: 'HcSr04.cs' },
    pinKeys: ['TRIG', 'ECHO'],
    pins: () => [
      { key: 'TRIG', dir: 'out', index: 0, label: 'HC-SR04 Trigger' },
      { key: 'ECHO', dir: 'in', output: 'Echo', label: 'HC-SR04 Echo' },
    ],
    attrs: (el) => ({ distance: el.initial ?? 100 }),
    check: (el) => ((el.min ?? 0) < (el.max ?? 400) ? [] : ['min < max']),
    widget: (el) => ({ min: 0, max: 400, unit: 'cm', ...pick(el, ['min', 'max', 'unit', 'initial', 'title', 'label']) }),
  },

  mb1242: {
    gui: 'sensor',
    desc: 'ultrasonic sensor MaxBotix MB1242 on the I2C bus',
    fields: { ...LABEL, bus: F.re(I2C_BUS_RE, 'I2C-Bus "i2c0".."i2c9"'), address: F.i2cAddress, initial: F.int(0, 765), min: F.int(0, 765), max: F.int(1, 765), unit: F.str },
    model: { name: 'sensor', cls: 'Sensors.MaxBotixI2C', cs: 'MaxBotixI2C.cs', i2c: 0x70 },
    pins: () => [],
    check: (el) => ((el.min ?? 0) < (el.max ?? 400) ? [] : ['min < max']),
    widget: (el) => ({ min: 0, max: 400, unit: 'cm', ...pick(el, ['min', 'max', 'unit', 'initial', 'title', 'label']) }),
  },

  oled: {
    gui: 'oled',
    desc: 'OLED SSD1306 on the I2C bus',
    fields: { label: F.str, bus: F.re(I2C_BUS_RE, 'I2C-Bus "i2c0".."i2c9"'), address: F.i2cAddress, width: F.oneOf(128, 96, 64), height: F.oneOf(64, 32, 16) },
    model: { name: 'oled', cls: 'Video.SSD1306I2C', cs: 'SSD1306I2C.cs', i2c: 0x3c },
    pins: () => [],
    attrs: (el) => ({ width: el.width ?? 128, height: el.height ?? 64 }),
    widget: (el) => ({ width: el.width ?? 128, height: el.height ?? 64, ...pick(el, ['label']) }),
  },

  cio: {
    gui: 'cio',
    desc: 'printf() console as in Code Composer Studio (TI run-time library)',
    fields: { label: F.str },
    model: { name: 'cio', cls: 'Miscellaneous.TiCioConsole', cs: 'TiCioConsole.cs', sysbus: '<0xF0000000, +0x100>' },
    pins: () => [],
    widget: (el) => pick(el, ['label']),
  },
};

const TOP_FIELDS = {
  title: { check: F.str, required: true },
  description: F.str,
  quantumUs: F.int(1, 1000),
  uart: F.object,
  solution: F.object,
  elements: { check: (v) => (Array.isArray(v) ? null : 'list of elements expected'), required: true },
  scope: F.object,
};
const UART_FIELDS = {
  rx: F.pin,
  tx: F.pin,
  baud: F.int(50, 4000000),
  format: F.re(UART_FORMAT_RE, 'format like "8N1" or "7E1"'),
  label: F.str,
  localEcho: F.bool,
  crlf: F.bool,
};
const SOLUTION_FIELDS = {
  example: { check: F.re(ID_RE, 'name of the reference solution (examples/<name> or sim/solutions/<name>.elf)'), required: true },
  label: F.str,
};
// Zeitbasen des Oszilloskops (1-2-5-Folge, 1 us/div .. 1 s/div) wie im Frontend (Oscilloscope.jsx)
const SCOPE_TIMEBASES_US = [];
for (let e = 0; e <= 6; e++) for (const m of [1, 2, 5]) if (m * 10 ** e <= 1e6) SCOPE_TIMEBASES_US.push(m * 10 ** e);

const SCOPE_FIELDS = {
  channels: (v) => (Array.isArray(v) && v.length <= 4 ? null : 'list of up to 4 pins'),
  timebaseUs: (v) => (SCOPE_TIMEBASES_US.includes(v) ? null : `time base in µs/div, one of 1, 2, 5, 10, 20, 50 … 1000000`),
  trigger: F.object,
  signals: (v) => (Array.isArray(v) ? null : 'list of { pin, label }'),
};

// ---------------------------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------------------------

function range(n) {
  return Array.from({ length: n }, (_, i) => i);
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Beschriftung ohne angehängten Pin: "USR_SW1 (PJ0)" -> "USR_SW1" (Oszilloskop zeigt den Pin selbst) */
function shortLabel(el) {
  return String(el.label ?? el.id).replace(/\s*\(P[A-HJ-NPQ][0-7]\)\s*$/, '') || el.id;
}

function matrixSize(el) {
  const layout = Array.isArray(el.layout) && el.layout.length ? el.layout : PHONE_LAYOUT;
  return [layout.length, Array.isArray(layout[0]) ? layout[0].length : 0];
}

/** Felder eines Objekts prüfen; Schlüssel mit "_" am Anfang sind Kommentare */
function checkFields(obj, fields, where, errors, extra = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_') || extra.includes(k)) continue;
    const f = fields[k];
    if (!f) {
      errors.push(`${where}: unknown field "${k}" (allowed: ${[...Object.keys(fields), ...extra].join(', ')})`);
      continue;
    }
    const err = (f.check || f)(v);
    if (err) errors.push(`${where}.${k}: ${err}`);
  }
  for (const [k, f] of Object.entries(fields)) {
    if (f.required && obj[k] === undefined) errors.push(`${where}: required field "${k}" is missing`);
  }
}

function portOf(pin) {
  return `gpio${pin[1]}`;
}

function pinNumber(pin) {
  return Number(pin[2]);
}

function elementName(el, i) {
  return el && typeof el === 'object' && el.id ? `elements[${i}] (${el.type} ${el.id})` : `elements[${i}] (${el && el.type})`;
}

// ---------------------------------------------------------------------------------------------
// Prüfen und Erzeugen
// ---------------------------------------------------------------------------------------------

function build(spec, id) {
  const errors = [];
  const warnings = [];
  const fail = (extra = {}) => ({ errors, warnings, config: null, repl: null, resc: null, ...extra });

  if (!ID_RE.test(id || '')) errors.push(`file name "${id}": only letters, digits, _ and - (max. 64 characters)`);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    errors.push('The file must contain a JSON object');
    return fail();
  }
  checkFields(spec, TOP_FIELDS, 'Versuch', errors);
  const uart = spec.uart && typeof spec.uart === 'object' ? spec.uart : {};
  if (spec.uart) checkFields(uart, UART_FIELDS, 'uart', errors);
  if (spec.solution && typeof spec.solution === 'object') checkFields(spec.solution, SOLUTION_FIELDS, 'solution', errors);
  const scope = spec.scope && typeof spec.scope === 'object' ? spec.scope : {};
  if (spec.scope) checkFields(scope, SCOPE_FIELDS, 'scope', errors);
  const elements = Array.isArray(spec.elements) ? spec.elements : [];

  // --- UART zum PC-Terminal: Pins legen die UART-Nummer fest ----------------------------------
  const used = new Map(); // Pin -> Beschreibung des Benutzers
  const uartPins = resolveUartPins(uart, errors, warnings);
  if (uartPins) {
    used.set(uartPins.rx, 'uart.rx');
    used.set(uartPins.tx, 'uart.tx');
  }

  // --- Elemente einzeln ---------------------------------------------------------------------
  const guiOwner = new Map(); // Widget-Abschnitt -> Element (für Einzel-Widgets)
  const ids = new Map(); // gui -> Set(id)
  const i2cUsed = new Map(); // "i2c0:0x3C" -> Element
  const items = []; // gültige Elemente mit aufgelösten Pins

  elements.forEach((el, i) => {
    const where = elementName(el, i);
    if (!el || typeof el !== 'object' || Array.isArray(el)) {
      errors.push(`elements[${i}]: object expected`);
      return;
    }
    const t = TYPES[el.type];
    if (!t) {
      errors.push(`${where}: unknown type ${JSON.stringify(el.type)} (allowed: ${Object.keys(TYPES).join(', ')})`);
      return;
    }
    const before = errors.length;
    const hasPinMap = !!(t.pinKeys);
    checkFields(el, t.fields, where, errors, ['type', ...(hasPinMap ? ['pins', 'labels'] : ['labels'])]);
    if (t.check && errors.length === before) for (const msg of t.check(el)) errors.push(`${where}: ${msg}`);

    // Einzel-Widgets / eindeutige Namen
    if (t.list) {
      const set = ids.get(t.gui) || new Set();
      if (el.id && set.has(el.id)) errors.push(`${where}: id "${el.id}" occurs twice`);
      set.add(el.id);
      ids.set(t.gui, set);
      if (t.gui === 'leds' && set.size > LED_BRIDGE_INPUTS) {
        errors.push(`${where}: at most ${LED_BRIDGE_INPUTS} LEDs per experiment (the LED bridge has ${LED_BRIDGE_INPUTS} inputs)`);
      }
    } else if (guiOwner.has(t.gui)) {
      errors.push(`${where}: the web console has only one "${t.gui}" widget – already used by ${guiOwner.get(t.gui)}`);
    } else {
      guiOwner.set(t.gui, where);
    }

    // Pins auflösen
    const defs = t.pins(el);
    const pins = {};
    if (hasPinMap) {
      const keys = typeof t.pinKeys === 'function' ? t.pinKeys(el) : t.pinKeys;
      const map = el.pins;
      if (!map || typeof map !== 'object' || Array.isArray(map)) {
        errors.push(`${where}: "pins" is missing – mapping ${keys.map((k) => `"${k}": "P.."`).join(', ')}`);
      } else {
        for (const k of Object.keys(map)) {
          if (k.startsWith('_')) continue;
          if (!keys.includes(k)) errors.push(`${where}.pins: unknown terminal "${k}" (allowed: ${keys.join(', ')})`);
        }
        for (const k of keys) {
          if (map[k] === undefined) errors.push(`${where}.pins: terminal "${k}" is missing`);
          else {
            const e = checkPinName(map[k]);
            if (e) errors.push(`${where}.pins.${k}: ${e}`);
            else pins[k] = map[k];
          }
        }
      }
      for (const d of defs) d.pin = pins[d.key];
    } else {
      for (const d of defs) if (d.pin && !checkPinName(d.pin)) pins[d.key] = d.pin;
    }
    if (el.labels !== undefined) {
      if (!el.labels || typeof el.labels !== 'object' || Array.isArray(el.labels)) errors.push(`${where}.labels: object { terminal: text } expected`);
      else {
        for (const [k, v] of Object.entries(el.labels)) {
          if (k.startsWith('_')) continue;
          if (!defs.some((d) => d.key === k)) errors.push(`${where}.labels: unknown terminal "${k}"`);
          else if (typeof v !== 'string') errors.push(`${where}.labels.${k}: text expected`);
        }
      }
    }

    // Belegung prüfen
    for (const d of defs) {
      if (!d.pin || checkPinName(d.pin)) continue;
      const who = `${where}${hasPinMap ? `.pins.${d.key}` : ''}`;
      if (RESERVED_PINS[d.pin]) errors.push(`${who}: ${d.pin} is reserved (${RESERVED_PINS[d.pin]})`);
      if (used.has(d.pin)) errors.push(`${who}: ${d.pin} is already used by ${used.get(d.pin)}`);
      else used.set(d.pin, who);
      if (LOCKED_PINS[d.pin]) {
        warnings.push(`${who}: ${d.pin} is protected (${LOCKED_PINS[d.pin]}) – the firmware must unlock it with GPIOLOCK/GPIOCR`);
      }
    }

    // I2C
    if (t.model && t.model.i2c !== undefined) {
      const bus = el.bus || 'i2c0';
      const addr = el.address !== undefined ? parseAddress(el.address) : t.model.i2c;
      if (addr !== null) {
        const key = `${bus}:${hex(addr)}`;
        if (i2cUsed.has(key)) errors.push(`${where}: I2C address ${hex(addr)} on ${bus} is already used by ${i2cUsed.get(key)}`);
        i2cUsed.set(key, where);
      }
    }

    items.push({ el, t, where, defs, pins });
  });

  // Pins der benutzten I2C-Busse
  for (const [bus, busPins] of Object.entries(I2C_PINS)) {
    if (![...i2cUsed.keys()].some((k) => k.startsWith(`${bus}:`))) continue;
    for (const p of busPins) {
      if (used.has(p)) errors.push(`${used.get(p)}: ${p} is a pin of ${bus.toUpperCase()} (SCL/SDA), and an I2C device is connected to that bus`);
    }
  }
  // Pins, die auf dem Board schon verdrahtet sind (Hinweis), außer sie werden genau dafür benutzt
  for (const it of items) {
    for (const d of it.defs) {
      const board = d.pin && BOARD_PINS[d.pin];
      if (!board) continue;
      const sameUse = (it.el.type === 'led' && board.startsWith('LED')) || (it.el.type === 'button' && board.startsWith('Taster'));
      if (!sameUse) warnings.push(`${it.where}: on the board, ${d.pin} is connected to ${board} – on real hardware both are connected to the pin`);
    }
  }
  // Taster: Pull passend zur Polarität?
  for (const it of items) {
    if (it.el.type !== 'button') continue;
    const activeLow = it.el.activeLow !== false;
    if (activeLow && it.el.pull === 'down') warnings.push(`${it.where}: a push button to GND (activeLow) with a pull-down always reads LOW`);
    if (!activeLow && it.el.pull === 'up') warnings.push(`${it.where}: a push button to 3.3 V (activeLow: false) with a pull-up always reads HIGH`);
  }

  // Oszilloskop
  const knownPins = new Set(used.keys());
  const scopeCheckPin = (p, where) => {
    const e = checkPinName(p);
    if (e) errors.push(`${where}: ${e}`);
  };
  (Array.isArray(scope.channels) ? scope.channels : []).forEach((p, i) => p && scopeCheckPin(p, `scope.channels[${i}]`));
  if (scope.trigger && typeof scope.trigger === 'object') {
    checkFields(scope.trigger, { source: F.pin, edge: F.oneOf('rising', 'falling') }, 'scope.trigger', errors);
  }
  (Array.isArray(scope.signals) ? scope.signals : []).forEach((s, i) => {
    if (!s || typeof s !== 'object') errors.push(`scope.signals[${i}]: { pin, label } expected`);
    else checkFields(s, { pin: { check: F.pin, required: true }, label: { check: F.str, required: true } }, `scope.signals[${i}]`, errors);
  });
  for (const p of Array.isArray(scope.channels) ? scope.channels : []) {
    if (p && !checkPinName(p) && !knownPins.has(p)) warnings.push(`scope.channels: ${p} is not connected to anything`);
  }

  if (errors.length) return fail();
  return generate(spec, id, items, warnings, uartPins);
}

/**
 * RX/TX des Terminal-UARTs prüfen. Standard: UART0 an PA0/PA1 (virtueller COM-Port des Boards).
 * Liefert { n, rx, tx } oder null (Fehler stehen dann in errors).
 */
function resolveUartPins(uart, errors, warnings) {
  const rx = uart.rx ?? 'PA0';
  const tx = uart.tx ?? 'PA1';
  if (checkPinName(rx) || checkPinName(tx)) return null; // Meldung kommt aus checkFields
  const list = (table) =>
    Object.entries(table)
      .map(([p, n]) => `${p} (U${n})`)
      .join(', ');
  const nRx = UART_RX_PINS[rx];
  const nTx = UART_TX_PINS[tx];
  let ok = true;
  if (nRx === undefined) {
    errors.push(`uart.rx: ${rx} cannot be a UART receiver (GPIOPCTL). Possible: ${list(UART_RX_PINS)}`);
    ok = false;
  }
  if (nTx === undefined) {
    errors.push(`uart.tx: ${tx} cannot be a UART transmitter (GPIOPCTL). Possible: ${list(UART_TX_PINS)}`);
    ok = false;
  }
  if (!ok) return null;
  if (nRx !== nTx) {
    const rxOf = (n) => Object.keys(UART_RX_PINS).filter((p) => UART_RX_PINS[p] === n).join('/');
    const txOf = (n) => Object.keys(UART_TX_PINS).filter((p) => UART_TX_PINS[p] === n).join('/');
    errors.push(
      `uart: ${rx} is U${nRx}Rx, ${tx} is U${nTx}Tx – RX and TX must belong to the same UART ` +
        `(U${nRx}: RX ${rxOf(nRx)}, TX ${txOf(nRx)}; U${nTx}: RX ${rxOf(nTx)}, TX ${txOf(nTx)})`,
    );
    return null;
  }
  if (nRx !== 0) {
    warnings.push(
      `uart: UART${nRx} (${rx}/${tx}) – on the board, only UART0 (PA0/PA1) is connected to the virtual COM port; ` +
        `with UART${nRx}, real hardware needs a USB-to-serial adapter (3.3 V)`,
    );
  }
  for (const [what, p] of [['rx', rx], ['tx', tx]]) {
    if (BOARD_PINS[p] && nRx !== 0) warnings.push(`uart.${what}: on the board, ${p} is connected to ${BOARD_PINS[p]}`);
    if (LOCKED_PINS[p]) warnings.push(`uart.${what}: ${p} is protected – the firmware must unlock it with GPIOLOCK/GPIOCR`);
  }
  return { n: nRx, rx, tx };
}

function generate(spec, id, items, warnings, uartPins) {
  const uart = spec.uart || {};
  const baud = uart.baud ?? 115200;
  const format = uart.format ?? '8N1';
  const { n: un, rx: urx, tx: utx } = uartPins;
  const uartName = `uart${un}`;
  const quantumUs = spec.quantumUs ?? 10;

  // --- interne Konfiguration (Form wie bisher, siehe lib/experiments.js) ----------------------
  const config = {
    title: spec.title,
    machine: 'tm4c1294',
    uart: {
      label: uart.label ?? `UART${un} (${urx} RX / ${utx} TX) – Terminal ${baud} ${format}`,
      ...pick(uart, ['localEcho', 'crlf']),
      host: `sysbus.${uartName}.host`,
      baud,
      format,
    },
    reset: { path: 'sysbus.sysctl' },
    status: { path: 'sysbus.sysctl' },
    debug: { cpu: 'sysbus.cpu' },
    signals: [
      { name: `${uartName}.tx`, label: `U${un}TX (${utx})`, path: `sysbus.${uartName}` },
      { name: `${uartName}.rx`, label: `U${un}RX (${urx})`, path: `sysbus.${uartName}` },
    ],
  };
  if (spec.description) config.description = spec.description;

  const devices = []; // { name, cls, parent, attrs, outputs: [ 'Y0 -> gpioM@4' ] }
  const portLines = new Map(); // gpioX -> [ 'n -> dev@i' ]
  const pulls = new Map(); // gpioX -> { up, down }
  const includes = [];
  const rescExtra = [];
  const scopeSignals = [];
  let bridge = 0;

  const addPortLine = (pin, line) => {
    const port = portOf(pin);
    if (!portLines.has(port)) portLines.set(port, []);
    portLines.get(port).push({ n: pinNumber(pin), line });
  };

  for (const { el, t, defs, pins } of items) {
    const labels = el.labels || {};
    for (const d of defs) if (d.pin) scopeSignals.push({ pin: d.pin, label: labels[d.key] ?? d.label });

    if (el.type === 'led') {
      const k = bridge++;
      addPortLine(el.pin, `${pinNumber(el.pin)} -> wsBridge@${k}`);
      (config.leds = config.leds || []).push({ id: el.id, label: el.label ?? `${el.id} (${el.pin})`, ...(el.color ? { color: el.color } : {}), bridge: k });
      continue;
    }
    if (el.type === 'button') {
      (config.buttons = config.buttons || []).push({
        id: el.id,
        label: el.label ?? `${el.id} (${el.pin})`,
        port: `sysbus.${portOf(el.pin)}`,
        pin: pinNumber(el.pin),
        activeLow: el.activeLow !== false,
      });
      if (el.pull === 'up' || el.pull === 'down') {
        const port = portOf(el.pin);
        const p = pulls.get(port) || { up: 0, down: 0 };
        p[el.pull] |= 1 << pinNumber(el.pin);
        pulls.set(port, p);
      }
      continue;
    }

    const m = t.model;
    if (!includes.includes(m.cs)) includes.push(m.cs);
    let parent;
    let path;
    if (m.i2c !== undefined) {
      const bus = el.bus || 'i2c0';
      const addr = el.address !== undefined ? parseAddress(el.address) : m.i2c;
      parent = `${bus} ${hex(addr)}`;
      path = `sysbus.${bus}.${m.name}`;
    } else if (m.sysbus) {
      parent = `sysbus ${m.sysbus}`;
      path = `sysbus.${m.name}`;
    } else {
      // Gerät ohne Busadresse: im Renode-Baum unter dem Port des ersten Anschlusses
      const port = portOf(defs.find((d) => d.pin).pin);
      parent = port;
      path = `sysbus.${port}.${m.name}`;
    }
    const outputs = [];
    for (const d of defs) {
      if (d.dir === 'out') addPortLine(d.pin, `${pinNumber(d.pin)} -> ${m.name}@${d.index}`);
      else if (d.dir === 'in') outputs.push(`${d.output} -> ${portOf(d.pin)}@${pinNumber(d.pin)}`);
    }
    devices.push({ name: m.name, cls: m.cls, parent, attrs: t.attrs ? t.attrs(el) : {}, outputs, el });

    const widget = { path, ...(t.widget ? t.widget(el, pins) : {}) };
    config[t.gui] = widget;
    if (el.type === 'cio') rescExtra.push(`sysbus.cio ElfPath $elf`);
    if (el.type === 'mb1242' && el.initial !== undefined) rescExtra.push(`${path} Distance ${el.initial}`);
  }
  if (config.leds) config.ledBridge = LED_BRIDGE;
  else config.leds = [];
  if (!config.buttons) config.buttons = [];

  // Oszilloskop: benannte Signale aus den Elementen, dann UART, dann eigene Ergänzungen/Beschriftungen
  const sc = spec.scope || {};
  const signals = [
    ...scopeSignals,
    { pin: urx, label: `U${un}RX (from terminal)` },
    { pin: utx, label: `U${un}TX (to terminal)` },
  ];
  for (const s of sc.signals || []) {
    const old = signals.find((x) => x.pin === s.pin);
    if (old) old.label = s.label;
    else signals.push({ pin: s.pin, label: s.label });
  }
  config.scope = {
    signals,
    channels: sc.channels ?? signals.slice(0, 4).map((s) => s.pin),
    ...(sc.trigger ? { trigger: sc.trigger } : {}),
    ...(sc.timebaseUs ? { timebaseUs: sc.timebaseUs } : {}),
  };
  if (spec.solution) config.solution = pick(spec.solution, ['example', 'label']);

  // --- .repl -------------------------------------------------------------------------------
  const L = [];
  L.push(`// ${spec.title}`);
  L.push(`// GENERATED from experiments/${id}.json – do not edit by hand (check with: node tools/check_experiment.js).`);
  L.push('// Extension of the platform platforms/tm4c1294ncpdt.repl (loaded AFTER it).');
  L.push('');
  L.push(`// PC terminal on UART${un} (RX ${urx}, TX ${utx}${un === 0 ? ', virtual COM port of the board' : ''}); settings can be changed in the web console`);
  L.push(`host: UART.UartHostTerminal @ ${uartName}`);
  L.push(`    baudRate: ${baud}`);
  L.push(`    format: "${format}"`);
  if (bridge > 0) {
    L.push('');
    L.push(`// LED display in the browser (${LED_BRIDGE}), inputs 0..${bridge - 1} = LEDs in the order of the experiment file`);
    L.push('wsBridge: Miscellaneous.WebSocketBridge');
  }
  for (const d of devices) {
    L.push('');
    L.push(`// ${d.el.type}: ${TYPES[d.el.type].desc}`);
    L.push(`${d.name}: ${d.cls} @ ${d.parent}`);
    for (const [k, v] of Object.entries(d.attrs)) L.push(`    ${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`);
    for (const o of d.outputs) L.push(`    ${o}`);
  }
  for (const port of [...portLines.keys()].sort()) {
    L.push('');
    L.push(`${port}:`);
    for (const { line } of portLines.get(port).sort((a, b) => a.n - b.n)) L.push(`    ${line}`);
  }
  const repl = `${L.join('\n')}\n`;

  // --- .resc -------------------------------------------------------------------------------
  const resc = (replPath) => {
    const R = [];
    R.push(`:name: ${spec.title}`);
    R.push(`:description: generated from experiments/${id}.json`);
    R.push('');
    R.push('$elf?=@/tmp/app.elf');
    R.push(`$uartBaud?=${baud}`);
    R.push(`$uartFormat?="${format}"`);
    R.push('');
    for (const cs of includes) R.push(`include @models/${cs}`);
    R.push('include @tm4c1294.resc');
    R.push(`emulation SetGlobalQuantum "${quantum(quantumUs)}"`);
    R.push(`machine LoadPlatformDescription @${replPath}`);
    for (const port of [...pulls.keys()].sort()) {
      const p = pulls.get(port);
      if (p.up) R.push(`sysbus.${port} ExternalPullUp ${hex(p.up)}`);
      if (p.down) R.push(`sysbus.${port} ExternalPullDown ${hex(p.down)}`);
    }
    if (!(un === 0 && urx === 'PA0' && utx === 'PA1')) {
      R.push(`sysbus.${uartName} SetPins "${utx}" "${urx}"`);
    }
    R.push(...rescExtra);
    R.push(`sysbus.${uartName}.host TerminalBaudRate $uartBaud`);
    R.push(`sysbus.${uartName}.host Format $uartFormat`);
    R.push(`sysbus.${uartName}.host ServeTcp 3335`);
    R.push('start');
    return `${R.join('\n')}\n`;
  };

  return { errors: [], warnings, config, repl, resc, models: includes };
}

/** Quantum in Sekunden ohne Exponentenschreibweise */
function quantum(us) {
  return (us / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/** Kurzbeschreibung des Formats für Hilfetexte */
function describeTypes() {
  return Object.entries(TYPES).map(([name, t]) => {
    const pins = t.pinKeys ? (typeof t.pinKeys === 'function' ? t.pinKeys({}) : t.pinKeys) : t.pins({ pin: 'P..' }).length ? ['pin'] : [];
    return { type: name, desc: t.desc, gui: t.gui, fields: Object.keys(t.fields), pins };
  });
}

module.exports = { build, describeTypes, TYPES, PORT_PINS, checkPinName, UART_RX_PINS, UART_TX_PINS, UART_PIN_FUNCTION };
