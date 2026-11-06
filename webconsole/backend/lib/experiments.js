'use strict';

/**
 * Versuche (Experimente) = Dateien in sim/experiments/:
 *   <id>.resc  Renode-Startskript (Pflicht)
 *   <id>.repl  Plattform-Erweiterung (optional, vom .resc geladen)
 *   <id>.json  Widget-Konfiguration für die Web-Konsole (optional)
 *
 * Alle Renode-Pfade aus der JSON-Datei werden validiert, weil das Backend aus ihnen
 * Monitor-Befehle baut. Der Browser schickt nie Pfade, nur IDs und Werte.
 */
const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const PATH_RE = /^sysbus(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const WS_RE = /^ws:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/;

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

function load(simDir, sub, id) {
  if (!isValidId(id)) return null;
  const base = dir(simDir, sub);
  const resc = path.join(base, `${id}.resc`);
  const json = path.join(base, `${id}.json`);
  if (!fs.existsSync(resc)) return null;
  let cfg = { id, title: id, machine: 'tm4c1294' };
  if (fs.existsSync(json)) {
    cfg = { ...cfg, ...JSON.parse(fs.readFileSync(json, 'utf8')), id };
  }
  // Pfad relativ zum Simulator-Verzeichnis (Arbeitsverzeichnis von Renode)
  return { ...validate(cfg, json), rescPath: `${sub}/${id}.resc` };
}

function list(simDir, sub) {
  const base = dir(simDir, sub);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .filter((f) => f.endsWith('.resc'))
    .map((f) => f.slice(0, -5))
    .filter(isValidId)
    .map((id) => {
      try {
        const c = load(simDir, sub, id);
        return c && { id: c.id, title: c.title };
      } catch (e) {
        console.error(`[experiments] ${e.message}`);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Konfiguration ohne interne Felder (für das Frontend). */
function publicView(cfg) {
  if (!cfg) return null;
  const { rescPath, ledBridge, ...rest } = cfg;
  return {
    ...rest,
    leds: (rest.leds || []).map(({ path: _p, bridge: _b, ...l }) => l),
    buttons: (rest.buttons || []).map(({ path: _p, port: _q, pin: _n, activeLow: _a, ...b }) => b),
    keypad: rest.keypad && { ...rest.keypad, path: undefined },
    oled: rest.oled && { ...rest.oled, path: undefined },
    sensor: rest.sensor && { ...rest.sensor, path: undefined },
    pendulum: rest.pendulum && { ...rest.pendulum, path: undefined },
  };
}

module.exports = { isValidId, load, list, publicView };
