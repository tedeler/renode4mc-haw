#!/usr/bin/env node
'use strict';

/**
 * Prüft Versuchsbeschreibungen (sim/experiments/<id>.json) – dieselbe Prüfung, die das Backend beim
 * Laden macht – und zeigt auf Wunsch, was daraus erzeugt wird.
 *
 *   node tools/check_experiment.js                      alle Versuche in sim/experiments/
 *   node tools/check_experiment.js mein_versuch.json    eine Datei (auch außerhalb von sim/experiments)
 *   node tools/check_experiment.js --repl lab1_gpio     erzeugte Renode-Plattform ausgeben
 *   node tools/check_experiment.js --out /tmp/v lab1_gpio
 *        .repl und .resc nach /tmp/v schreiben, dann ohne Web-Konsole starten:
 *        cd sim && renode -e "\$elf=@../firmware.out; s @/tmp/v/lab1_gpio.resc"
 *   node tools/check_experiment.js --types              Liste der Elementtypen und ihrer Anschlüsse
 *
 * Exit-Code: 0 = alles gültig (Hinweise erlaubt), 1 = Fehler gefunden, 2 = falscher Aufruf.
 * Format: docs/EXPERIMENTS.md
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SIM = path.join(ROOT, 'sim');
const EXPERIMENTS = path.join(SIM, 'experiments');
const spec = require(path.join(ROOT, 'webconsole', 'backend', 'lib', 'experimentSpec.js'));

const HELP = `Aufruf: node tools/check_experiment.js [Optionen] [Datei.json | Versuchs-ID | Verzeichnis ...]

Ohne Datei werden alle Versuche in sim/experiments/ geprüft.

Optionen:
  --repl         erzeugte Renode-Plattform (.repl) ausgeben
  --resc         erzeugtes Renode-Startskript (.resc) ausgeben
  --config       Konfiguration für die Web-Konsole ausgeben (JSON)
  --out DIR      .repl und .resc nach DIR schreiben (Renode ohne Web-Konsole starten)
  --types        Elementtypen, ihre Felder und Anschlüsse auflisten
  -q, --quiet    nur Fehler und Hinweise ausgeben
  -h, --help     diese Hilfe
`;

function parseArgs(argv) {
  const o = { files: [], repl: false, resc: false, config: false, out: null, types: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repl') o.repl = true;
    else if (a === '--resc') o.resc = true;
    else if (a === '--config') o.config = true;
    else if (a === '--types') o.types = true;
    else if (a === '-q' || a === '--quiet') o.quiet = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--out') {
      o.out = argv[++i];
      if (!o.out) throw new Error('--out braucht ein Verzeichnis');
    } else if (a.startsWith('-')) throw new Error(`unbekannte Option ${a}`);
    else o.files.push(a);
  }
  return o;
}

/** Argument -> Liste von JSON-Dateien */
function resolveFiles(args) {
  if (!args.length) args = [EXPERIMENTS];
  const files = [];
  for (const a of args) {
    let p = a;
    if (!fs.existsSync(p) && fs.existsSync(path.join(EXPERIMENTS, `${a}.json`))) p = path.join(EXPERIMENTS, `${a}.json`);
    if (!fs.existsSync(p)) throw new Error(`${a}: nicht gefunden (Datei, Verzeichnis oder Versuchs-ID in sim/experiments/)`);
    if (fs.statSync(p).isDirectory()) {
      const list = fs.readdirSync(p).filter((f) => f.endsWith('.json')).sort();
      if (!list.length) console.warn(`${p}: keine .json-Dateien`);
      files.push(...list.map((f) => path.join(p, f)));
    } else files.push(p);
  }
  return files;
}

function rel(p) {
  const r = path.relative(process.cwd(), p);
  return r && !r.startsWith('..') ? r : p;
}

/** Zusätzliche Prüfungen gegen das Repository (das Backend prüft nur das Format) */
function checkRepository(data, result) {
  const errors = [];
  const warnings = [];
  for (const cs of result.models || []) {
    if (!fs.existsSync(path.join(SIM, 'models', cs))) errors.push(`Gerätemodell sim/models/${cs} fehlt`);
  }
  const ex = data.solution && data.solution.example;
  if (ex && typeof ex === 'string') {
    if (!fs.existsSync(path.join(ROOT, 'examples', ex))) errors.push(`solution.example: examples/${ex} gibt es nicht`);
    else if (!fs.existsSync(path.join(SIM, 'solutions', `${ex}.elf`))) {
      warnings.push(`Musterlösung sim/solutions/${ex}.elf ist nicht gebaut (tools/build-solutions.sh) – Knopf "Musterlösung starten" bleibt aus`);
    }
  }
  return { errors, warnings };
}

function checkFile(file, o) {
  const id = path.basename(file).replace(/\.json$/i, '');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(`✗ ${rel(file)}: kein gültiges JSON – ${e.message}`);
    return false;
  }
  const r = spec.build(data, id);
  const extra = r.errors.length ? { errors: [], warnings: [] } : checkRepository(data, r);
  const errors = [...r.errors, ...extra.errors];
  const warnings = [...r.warnings, ...extra.warnings];
  const ok = errors.length === 0;

  if (ok) {
    const n = (data.elements || []).length;
    const pins = r.config.scope.signals.filter((s) => s.pin !== 'PA0' && s.pin !== 'PA1').length;
    if (!o.quiet || warnings.length) {
      console.log(`✓ ${rel(file)}: "${data.title}" – ${n} Elemente, ${pins} Pins${warnings.length ? `, ${warnings.length} Hinweis(e)` : ''}`);
    }
  } else {
    console.log(`✗ ${rel(file)}: ${errors.length} Fehler`);
  }
  for (const e of errors) console.log(`    Fehler:  ${e}`);
  for (const w of warnings) console.log(`    Hinweis: ${w}`);
  if (!ok) return false;

  if (o.config) console.log(JSON.stringify({ id, ...r.config }, null, 2));
  if (o.repl) process.stdout.write(`\n// ----- ${id}.repl -----\n${r.repl}`);
  const outDir = o.out && path.resolve(o.out);
  const replPath = outDir ? path.join(outDir, `${id}.repl`) : `/tmp/renode4mc-experiments/${id}.repl`;
  if (o.resc) process.stdout.write(`\n# ----- ${id}.resc -----\n${r.resc(replPath)}`);
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(replPath, r.repl);
    fs.writeFileSync(path.join(outDir, `${id}.resc`), r.resc(replPath));
    if (!o.quiet) {
      console.log(`    geschrieben: ${rel(replPath)}, ${rel(path.join(outDir, `${id}.resc`))}`);
      console.log(`    starten:     cd sim && renode -e "\\$elf=@<firmware.out>; s @${path.join(outDir, `${id}.resc`)}"`);
    }
  }
  return true;
}

function printTypes() {
  for (const t of spec.describeTypes()) {
    console.log(`${t.type.padEnd(10)} ${t.desc}`);
    console.log(`           Widget: ${t.gui}${['leds', 'buttons'].includes(t.gui) ? ' (mehrere möglich)' : ' (höchstens eines)'}`);
    if (t.pins.length) console.log(`           Anschlüsse: ${t.pins.join(', ')}${t.type === 'keypad' ? ' (Anzahl nach "layout")' : ''}`);
    console.log(`           Felder: ${t.fields.join(', ')}`);
  }
}

function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${HELP}`);
    return 2;
  }
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  if (o.types) {
    printTypes();
    return 0;
  }
  let files;
  try {
    files = resolveFiles(o.files);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  let bad = 0;
  for (const f of files) if (!checkFile(f, o)) bad++;
  if (files.length > 1 && !o.quiet) console.log(`\n${files.length - bad} von ${files.length} Versuchen gültig`);
  return bad ? 1 : 0;
}

process.exitCode = main();
