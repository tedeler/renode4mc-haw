'use strict';

/**
 * Versuche (Experimente) = je EINE Datei sim/experiments/<id>.json (Format: docs/EXPERIMENTS.md).
 * Sie zählt die Bedienelemente auf und legt für jedes die Pins fest. lib/experimentSpec.js prüft sie und
 * erzeugt daraus die Renode-Plattform (.repl), das Startskript (.resc) und die interne Konfiguration
 * (Renode-Pfade, Widget-Einstellungen). prepare() schreibt .repl/.resc vor dem Start in ein
 * temporäres Verzeichnis. Prüfen ohne Backend:  node tools/check_experiment.js
 *
 * Musterlösung: "solution": { "example": "<Beispiel>", "label": "..." } in der JSON-Datei verweist auf
 *   sim/solutions/<Beispiel>.elf (gebaut von tools/build-solutions.sh bzw. im Docker-Image).
 *
 * Alle Renode-Pfade aus der JSON-Datei werden validiert, weil das Backend aus ihnen
 * Monitor-Befehle baut. Der Browser schickt nie Pfade, nur IDs und Werte.
 */
const fs = require('fs');
const path = require('path');
const spec = require('./experimentSpec');

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const PATH_RE = /^sysbus(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const WS_RE = /^ws:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/;
const SIGNAL_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const UART_FORMAT_RE = /^[5-8][NOEMS][12]$/;

/** Einstellung des PC-Terminals: Baudrate 50..4 000 000, Format wie "8N1" */
function isValidUartSettings(baud, format) {
  return Number.isInteger(baud) && baud >= 50 && baud <= 4000000 && typeof format === 'string' && UART_FORMAT_RE.test(format);
}

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertPath(p, where) {
  assert(typeof p === 'string' && PATH_RE.test(p), `Ungültiger Renode-Pfad in ${where}: ${p}`);
}

function validate(cfg, file) {
  if (cfg.ledBridge !== undefined) {
    assert(WS_RE.test(cfg.ledBridge), `${file}: ledBridge muss ws://127.0.0.1:<port> sein`);
  }
  (cfg.leds || []).forEach((l, i) => {
    assert(typeof l.id === 'string' && l.id, `${file} leds[${i}]: id fehlt`);
    if (l.path !== undefined) assertPath(l.path, `${file} leds[${i}]`);
    else assert(Number.isInteger(l.bridge) && l.bridge >= 0 && l.bridge <= 7 && cfg.ledBridge,
      `${file} leds[${i}]: "path" oder "bridge" (0..7, mit ledBridge) angeben`);
  });
  (cfg.buttons || []).forEach((b, i) => {
    assert(typeof b.id === 'string' && b.id, `${file} buttons[${i}]: id fehlt`);
    if (b.path !== undefined) assertPath(b.path, `${file} buttons[${i}]`);
    else {
      assertPath(b.port, `${file} buttons[${i}].port`);
      assert(Number.isInteger(b.pin) && b.pin >= 0 && b.pin <= 31, `${file} buttons[${i}].pin`);
    }
  });
  if (cfg.oled) assertPath(cfg.oled.path, `${file} oled`);
  if (cfg.bcd) assertPath(cfg.bcd.path, `${file} bcd`);
  if (cfg.cio) assertPath(cfg.cio.path, `${file} cio`);
  if (cfg.sensor) assertPath(cfg.sensor.path, `${file} sensor`);
  if (cfg.pendulum) {
    const pd = cfg.pendulum;
    assertPath(pd.path, `${file} pendulum`);
    // Frequenzbereich für den Schieberegler (Modell: 0,05..100 Hz)
    pd.frequency = pd.frequency ?? 10;
    pd.minFrequency = pd.minFrequency ?? pd.frequency;
    pd.maxFrequency = pd.maxFrequency ?? pd.frequency;
    assert([pd.frequency, pd.minFrequency, pd.maxFrequency].every((f) => typeof f === 'number' && f >= 0.05 && f <= 100) &&
      pd.minFrequency <= pd.frequency && pd.frequency <= pd.maxFrequency,
    `${file} pendulum: 0.05 <= minFrequency <= frequency <= maxFrequency <= 100 (Hz)`);
  }
  if (cfg.uart && cfg.uart.host !== undefined) {
    assertPath(cfg.uart.host, `${file} uart.host`);
    cfg.uart.baud = cfg.uart.baud ?? 115200;
    cfg.uart.format = cfg.uart.format ?? '8N1';
    assert(isValidUartSettings(cfg.uart.baud, cfg.uart.format), `${file} uart: baud 50..4000000, format wie "8N1"`);
  }
  if (cfg.reset) assertPath(cfg.reset.path, `${file} reset.path`);
  if (cfg.status) assertPath(cfg.status.path, `${file} status.path`);
  if (cfg.debug) assertPath(cfg.debug.cpu, `${file} debug.cpu`);
  (cfg.signals || []).forEach((sig, i) => {
    assert(typeof sig.name === 'string' && SIGNAL_RE.test(sig.name), `${file} signals[${i}].name wie "uart0.tx"`);
    assertPath(sig.path, `${file} signals[${i}].path`);
  });
  if (cfg.scope) {
    // Oszilloskop: benannte Signale für die Auswahl, Startbelegung CH1..CH4, Trigger
    const sc = cfg.scope;
    const pin = (p) => typeof p === 'string' && /^P[A-HJ-NPQ][0-7]$/.test(p);
    (sc.signals || []).forEach((g, i) => assert(pin(g.pin) && typeof g.label === 'string', `${file} scope.signals[${i}]: { pin: "PD0", label }`));
    assert(!sc.channels || (Array.isArray(sc.channels) && sc.channels.length <= 4 && sc.channels.every((p) => !p || pin(p))),
      `${file} scope.channels: bis zu 4 Pins`);
    assert(!sc.trigger || ((!sc.trigger.source || pin(sc.trigger.source)) && (!sc.trigger.edge || ['rising', 'falling'].includes(sc.trigger.edge))),
      `${file} scope.trigger: { source: "PL0", edge: "rising" | "falling" }`);
  }
  if (cfg.solution) {
    assert(isValidId(cfg.solution.example), `${file} solution.example: Name eines Beispiels (examples/<name>)`);
  }
  if (cfg.keypad) {
    assertPath(cfg.keypad.path, `${file} keypad.path`);
    const layout = cfg.keypad.layout;
    assert(Array.isArray(layout) && layout.length > 0 && layout.length <= 8 &&
      layout.every((r) => Array.isArray(r) && r.length === layout[0].length && r.length <= 4),
    `${file} keypad.layout: Zeilen gleicher Länge (max. 8 x 4)`);
  }
  return cfg;
}

function dir(simDir, sub) {
  return path.join(simDir, sub);
}

/**
 * Versuchsbeschreibung lesen und prüfen. Liefert null, wenn es die Datei nicht gibt; wirft bei Fehlern
 * (alle Meldungen in der Fehlermeldung).
 */
function load(simDir, sub, id) {
  if (!isValidId(id)) return null;
  const json = path.join(dir(simDir, sub), `${id}.json`);
  if (!fs.existsSync(json)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(json, 'utf8'));
  } catch (e) {
    throw new Error(`${json}: kein gültiges JSON (${e.message})`);
  }
  const r = spec.build(data, id);
  if (r.errors.length) throw new Error(`${json}: ${r.errors.length} Fehler\n  ${r.errors.join('\n  ')}`);
  for (const w of r.warnings) console.warn(`[experiments] ${id}: Hinweis: ${w}`);
  // Zweite Sicherung: dieselben Prüfungen wie für die frühere handgeschriebene Konfiguration
  const v = validate({ id, ...r.config }, json);
  const solutionPath = v.solution ? path.join(simDir, 'solutions', `${v.solution.example}.elf`) : null;
  return { ...v, solutionPath, generated: { repl: r.repl, resc: r.resc } };
}

/**
 * Erzeugte Plattform und Startskript nach genDir schreiben; liefert den absoluten Pfad des .resc
 * (Renode läuft mit Arbeitsverzeichnis sim/, die Modelle werden relativ dazu geladen).
 */
function prepare(exp, genDir) {
  fs.mkdirSync(genDir, { recursive: true });
  const repl = path.resolve(genDir, `${exp.id}.repl`);
  const resc = path.resolve(genDir, `${exp.id}.resc`);
  fs.writeFileSync(repl, exp.generated.repl);
  fs.writeFileSync(resc, exp.generated.resc(repl));
  return resc;
}

function list(simDir, sub) {
  const base = dir(simDir, sub);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter(isValidId)
    .map((id) => {
      try {
        const c = load(simDir, sub, id);
        return c && { id: c.id, title: c.title, solution: solutionInfo(c) };
      } catch (e) {
        console.error(`[experiments] ${e.message}`);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Musterlösung für das Frontend: { label, available } oder null */
function solutionInfo(cfg) {
  if (!cfg || !cfg.solution) return null;
  return {
    label: cfg.solution.label || `Musterlösung (examples/${cfg.solution.example})`,
    available: !!cfg.solutionPath && fs.existsSync(cfg.solutionPath),
  };
}

/** Konfiguration ohne interne Felder (für das Frontend). */
function publicView(cfg) {
  if (!cfg) return null;
  const { ledBridge, solutionPath: _s, generated: _g, ...rest } = cfg;
  return {
    ...rest,
    solution: solutionInfo(cfg),
    leds: (rest.leds || []).map(({ path: _p, bridge: _b, ...l }) => l),
    buttons: (rest.buttons || []).map(({ path: _p, port: _q, pin: _n, activeLow: _a, ...b }) => b),
    keypad: rest.keypad && { ...rest.keypad, path: undefined },
    oled: rest.oled && { ...rest.oled, path: undefined },
    bcd: rest.bcd && { ...rest.bcd, path: undefined },
    cio: rest.cio && { ...rest.cio, path: undefined },
    sensor: rest.sensor && { ...rest.sensor, path: undefined },
    pendulum: rest.pendulum && { ...rest.pendulum, path: undefined },
    uart: rest.uart && { ...rest.uart, host: undefined },
    reset: !!rest.reset,
    status: !!rest.status,
    debug: !!rest.debug,
    signals: (rest.signals || []).map(({ path: _p, ...sig }) => sig),
  };
}

module.exports = { isValidId, isValidUartSettings, load, list, prepare, publicView };
