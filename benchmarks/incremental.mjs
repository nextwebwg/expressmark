// Time a one-character edit in a large README: `parseDoc`'s edit, which
// re-reads the blocks the edit changes, against a full `parse` of the edited
// text. Both run in this process on the same build, alternating per sample.
// Usage: node benchmarks/incremental.mjs [--candidate=<path>] > results.json
import assert from "node:assert/strict";
import { arch, cpus, loadavg, platform } from "node:os";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { inputSet } from "./corpus.mjs";

const root = resolve(process.argv.find(arg => arg.startsWith("--candidate="))?.slice(12) ?? new URL("../", import.meta.url).pathname);
const { parse, parseDoc } = await import(`${root}/dist/index.js`);
const rounds = Number(process.env.BENCH_ROUNDS ?? 21);
const positions = Number(process.env.BENCH_EDITS ?? 9);
const median = values => { const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1; return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; };

const documents = await inputSet("readmes");
const name = process.env.BENCH_INCREMENTAL_FILE;
const text = name ? documents.find((_, index) => documents.names?.[index] === name) : documents.reduce((a, b) => b.length > a.length ? b : a);
assert(text, "no README to edit");
// Edits land inside words of prose lines spread through the document.
const lines = text.split("\n");
const offsets = [];
let offset = 0;
const candidates = [];
for (const line of lines) { if (/^[A-Za-z][^|<>`]*[a-z] [a-z]/.test(line)) candidates.push(offset + line.indexOf(" ")); offset += line.length + 1; }
for (let i = 0; i < positions; i++) offsets.push(candidates[Math.floor((i + 0.5) * candidates.length / positions)]);

const results = [];
for (const syntax of ["compatible", "standard"]) {
  const options = { syntax };
  const doc = parseDoc(text, options);
  const edits = offsets.map(at => ({ at, edited: `${text.slice(0, at)}x${text.slice(at)}` }));
  for (const { at, edited } of edits) assert.equal(JSON.stringify(doc.edit(at, at, "x").document), JSON.stringify(parse(edited, options)), `the edit at ${at} reads as a full parse`);
  const time = run => { const start = performance.now(); let count = 0; do { run(); count++; } while (performance.now() - start < 50); return (performance.now() - start) / count; };
  for (let i = 0; i < 5; i++) for (const { at, edited } of edits) { parse(edited, options); doc.edit(at, at, "x"); }
  const full = [], incremental = [];
  for (let round = 0; round < rounds; round++) {
    const { at, edited } = edits[round % edits.length];
    const sides = [() => full.push(time(() => parse(edited, options))), () => incremental.push(time(() => doc.edit(at, at, "x")))];
    if (round % 2) sides.reverse();
    for (const side of sides) side();
  }
  const ratios = incremental.map((ms, round) => ms / full[round]);
  const summary = ms => ({ medianMs: median(ms), q1Ms: quantile(ms, 0.25), q3Ms: quantile(ms, 0.75), minMs: Math.min(...ms), maxMs: Math.max(...ms), roundsMs: ms });
  results.push({ syntax, bytes: Buffer.byteLength(text), lines: lines.length, edits: offsets, full: summary(full), incremental: summary(incremental),
    ratio: median(incremental) / median(full), minRoundRatio: Math.min(...ratios), maxRoundRatio: Math.max(...ratios), roundRatios: ratios });
  console.error(`${syntax}: full parse ${median(full).toFixed(2)} ms, edit ${median(incremental).toFixed(3)} ms, ratio ${(median(incremental) / median(full)).toFixed(4)}`);
}
console.log(JSON.stringify({ schema: "incremental", schemaVersion: 1, measuredAt: new Date().toISOString(),
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, cores: cpus().length, loadAverage: loadavg() },
  protocol: { rounds, positions, sample: "mean of runs repeated for at least 50 ms; full parse and edit alternate order per round; each round edits the next position", document: "the largest README in the corpus unless BENCH_INCREMENTAL_FILE names one" },
  results }, null, 2));
