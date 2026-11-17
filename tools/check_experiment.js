#!/usr/bin/env node
'use strict';

/**
 * Checks experiment descriptions (sim/experiments/<id>.json) – the same check the backend performs
 * when loading them – and, on request, shows what is generated from them.
 *
 *   node tools/check_experiment.js                      all experiments in sim/experiments/
 *   node tools/check_experiment.js my_experiment.json   one file (may also be outside sim/experiments)
 *   node tools/check_experiment.js --repl lab1_gpio     print the generated Renode platform
 *   node tools/check_experiment.js --out /tmp/v lab1_gpio
 *        write .repl and .resc to /tmp/v, then start without the web console:
 *        cd sim && renode -e "\$elf=@../firmware.out; s @/tmp/v/lab1_gpio.resc"
 *   node tools/check_experiment.js --types              list of element types and their terminals
 *
 * Exit code: 0 = everything valid (notes allowed), 1 = errors found, 2 = wrong usage.
 * Format: docs/EXPERIMENTS.md
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SIM = path.join(ROOT, 'sim');
const EXPERIMENTS = path.join(SIM, 'experiments');
const spec = require(path.join(ROOT, 'webconsole', 'backend', 'lib', 'experimentSpec.js'));

const HELP = `Usage: node tools/check_experiment.js [options] [file.json | experiment ID | directory ...]

Without a file, all experiments in sim/experiments/ are checked.

Options:
  --repl         print the generated Renode platform (.repl)
  --resc         print the generated Renode start script (.resc)
  --config       print the configuration for the web console (JSON)
  --out DIR      write .repl and .resc to DIR (to start Renode without the web console)
  --types        list the element types, their fields and terminals
  -q, --quiet    only print errors and notes
  -h, --help     this help
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
      if (!o.out) throw new Error('--out needs a directory');
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o.files.push(a);
  }
  return o;
}

/** argument -> list of JSON files */
function resolveFiles(args) {
  if (!args.length) args = [EXPERIMENTS];
  const files = [];
  for (const a of args) {
    let p = a;
    if (!fs.existsSync(p) && fs.existsSync(path.join(EXPERIMENTS, `${a}.json`))) p = path.join(EXPERIMENTS, `${a}.json`);
    if (!fs.existsSync(p)) throw new Error(`${a}: not found (file, directory or experiment ID in sim/experiments/)`);
    if (fs.statSync(p).isDirectory()) {
      const list = fs.readdirSync(p).filter((f) => f.endsWith('.json')).sort();
      if (!list.length) console.warn(`${p}: no .json files`);
      files.push(...list.map((f) => path.join(p, f)));
    } else files.push(p);
  }
  return files;
}

function rel(p) {
  const r = path.relative(process.cwd(), p);
  return r && !r.startsWith('..') ? r : p;
}

/** Additional checks against the repository (the backend only checks the format) */
function checkRepository(data, result) {
  const errors = [];
  const warnings = [];
  for (const cs of result.models || []) {
    if (!fs.existsSync(path.join(SIM, 'models', cs))) errors.push(`device model sim/models/${cs} is missing`);
  }
  const ex = data.solution && data.solution.example;
  if (ex && typeof ex === 'string') {
    // sources: examples/<name> (public) or solutions/labs/<name>/code (private submodule, only
    // checked out by teaching staff). Without sources the ready-made sim/solutions/<name>.elf is enough.
    const src = [path.join(ROOT, 'examples', ex), path.join(ROOT, 'solutions', 'labs', ex, 'code')].some((d) => fs.existsSync(d));
    const elf = fs.existsSync(path.join(SIM, 'solutions', `${ex}.elf`));
    if (!src && !elf) {
      errors.push(`solution.example: neither sources (examples/${ex}, solutions/labs/${ex}/code) nor sim/solutions/${ex}.elf`);
    } else if (!elf) {
      warnings.push(`reference solution sim/solutions/${ex}.elf is not built (tools/build-solutions.sh) – the "Reference solution" button stays disabled`);
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
    console.log(`✗ ${rel(file)}: not valid JSON – ${e.message}`);
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
      console.log(`✓ ${rel(file)}: "${data.title}" – ${n} elements, ${pins} pins${warnings.length ? `, ${warnings.length} note(s)` : ''}`);
    }
  } else {
    console.log(`✗ ${rel(file)}: ${errors.length} error(s)`);
  }
  for (const e of errors) console.log(`    error: ${e}`);
  for (const w of warnings) console.log(`    note:  ${w}`);
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
      console.log(`    written: ${rel(replPath)}, ${rel(path.join(outDir, `${id}.resc`))}`);
      console.log(`    start:   cd sim && renode -e "\\$elf=@<firmware.out>; s @${path.join(outDir, `${id}.resc`)}"`);
    }
  }
  return true;
}

function printTypes() {
  for (const t of spec.describeTypes()) {
    console.log(`${t.type.padEnd(10)} ${t.desc}`);
    console.log(`           Widget: ${t.gui}${['leds', 'buttons'].includes(t.gui) ? ' (several allowed)' : ' (at most one)'}`);
    if (t.pins.length) console.log(`           Terminals: ${t.pins.join(', ')}${t.type === 'keypad' ? ' (number depends on "layout")' : ''}`);
    console.log(`           Fields: ${t.fields.join(', ')}`);
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
  if (files.length > 1 && !o.quiet) console.log(`\n${files.length - bad} of ${files.length} experiments valid`);
  return bad ? 1 : 0;
}

process.exitCode = main();
