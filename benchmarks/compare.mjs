// Parse the same input sets with two expressmark checkouts, interleaving their
// runs so both see the same machine load, and report parse time, memory and
// whether their outputs agree.
// Usage: node benchmarks/compare.mjs --base=<path-or-git-ref> [--candidate=<path>] > results.json
//
// Timing for one input set and syntax runs in one child process that imports
// both builds and alternates them, base first then candidate first (A B B A),
// for every round. Memory runs in one child process per build.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { arch, cpus, loadavg, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { checkouts } from "./checkout.mjs";
import { digest, inputSet, setNames } from "./corpus.mjs";

const list = (value, all) => value ? value.split(",").map(item => item.trim()).filter(Boolean) : all;
const rounds = Number(process.env.BENCH_ROUNDS ?? 15);
const durationMs = Number(process.env.BENCH_DURATION_MS ?? 200);
const warmupMs = Number(process.env.BENCH_WARMUP_MS ?? 500);
assert(Number.isInteger(rounds) && rounds >= 4, "BENCH_ROUNDS must be an integer >= 4");
assert(durationMs >= 10 && warmupMs >= 0, "BENCH_DURATION_MS must be >= 10");
const optionsFor = syntax => ({ syntax });
const median = values => { const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1; return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; };

function passes(parse, documents, options) {
  return () => { let last; for (const source of documents) { try { last = parse(source, options); } catch { /* reported with the outputs */ } } return last; };
}
let sink;
const timed = (pass, milliseconds) => { let count = 0; const start = performance.now(); do { sink = pass(); count++; } while (performance.now() - start < milliseconds); return (performance.now() - start) / count; };

if (process.argv[2] === "--time") {
  const [, , , setName, syntax, ...entries] = process.argv;
  const documents = await inputSet(setName), options = optionsFor(syntax);
  const legs = await Promise.all(entries.map(async entry => (await import(entry)).parse));
  const outputs = legs.map(parse => documents.map(source => {
    try { return createHash("sha1").update(JSON.stringify(parse(source, options))).digest("hex"); }
    catch (error) { return `threw: ${error instanceof Error ? error.message : String(error)}`; }
  }));
  const runs = legs.map(parse => passes(parse, documents, options));
  for (const run of runs) timed(run, warmupMs);
  const ms = legs.map(() => []);
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 ? [1, 0] : [0, 1];
    for (const leg of order) ms[leg].push(timed(runs[leg], durationMs));
  }
  assert(sink !== undefined || documents.length === 0);
  console.log(JSON.stringify({ documents: documents.length, bytes: documents.reduce((sum, source) => sum + Buffer.byteLength(source), 0), inputSha256: digest(documents), ms, outputs }));
  process.exit(0);
}
if (process.argv[2] === "--memory") {
  const [, , , setName, syntax, entry] = process.argv;
  const documents = await inputSet(setName), options = optionsFor(syntax);
  const { parse } = await import(entry);
  timed(passes(parse, documents, options), warmupMs);
  // Retained: the heap one pass's documents keep alive, measured as the drop when they are released.
  const collect = () => { for (let i = 0; i < 4; i++) globalThis.gc(); return process.memoryUsage().heapUsed; };
  let kept = documents.map(source => { try { return parse(source, options); } catch { return undefined; } });
  const holding = collect();
  kept = undefined;
  const retained = holding - collect();
  // Peak: the highest heap one pass reaches above a collected baseline.
  const base = collect(); let peak = 0;
  for (const source of documents) { try { parse(source, options); } catch { /* reported with the outputs */ } peak = Math.max(peak, process.memoryUsage().heapUsed - base); }
  console.log(JSON.stringify({ retainedBytes: retained, peakBytes: peak, released: kept === undefined }));
  process.exit(0);
}

const legs = checkouts();
// Print what each leg runs before any number, so a mislabelled leg is visible.
for (const leg of legs) console.error(`${leg.name}: expressmark ${leg.version} (${leg.engine}) at ${leg.dir} ${leg.commit.slice(0, 12)}${leg.dirty ? " (dirty)" : ""}`);
const load = loadavg();
if (load[0] > 3) console.error(`warning: load average ${load[0].toFixed(2)}; timings need a quiet machine`);
const child = (...args) => {
  const result = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), ...args], { encoding: "utf8", maxBuffer: 1 << 28, env: process.env });
  if (result.status !== 0) throw new Error(`${args.join(" ")} failed:\n${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
};
const results = [];
for (const set of list(process.env.BENCH_SETS, setNames)) for (const syntax of list(process.env.BENCH_SYNTAXES, ["compatible", "standard"])) {
  const timing = child("--time", set, syntax, ...legs.map(leg => leg.entry));
  const memory = legs.map(leg => child("--memory", set, syntax, leg.entry));
  const [base, candidate] = timing.ms;
  const ratios = candidate.map((ms, round) => ms / base[round]);
  const differing = timing.outputs[1].flatMap((output, index) => output === timing.outputs[0][index] ? [] : [index]);
  const summary = (ms, leg) => ({ medianMs: median(ms), minMs: Math.min(...ms), maxMs: Math.max(...ms), q1Ms: quantile(ms, 0.25), q3Ms: quantile(ms, 0.75), roundsMs: ms,
    retainedBytes: memory[leg].retainedBytes, peakBytes: memory[leg].peakBytes, threw: timing.outputs[leg].filter(output => output.startsWith("threw:")).length });
  results.push({ set, syntax, documents: timing.documents, bytes: timing.bytes, inputSha256: timing.inputSha256,
    base: summary(base, 0), candidate: summary(candidate, 1),
    ratio: median(candidate) / median(base), medianRoundRatio: median(ratios), minRoundRatio: Math.min(...ratios), maxRoundRatio: Math.max(...ratios), roundRatios: ratios,
    differing: differing.length, firstDiffering: differing.slice(0, 10) });
  console.error(`${set} ${syntax}: base ${median(base).toFixed(2)} ms, candidate ${median(candidate).toFixed(2)} ms, ratio ${(median(candidate) / median(base)).toFixed(3)} (rounds ${Math.min(...ratios).toFixed(3)}–${Math.max(...ratios).toFixed(3)}), ${differing.length} differing`);
}
console.log(JSON.stringify({ schema: "compare", schemaVersion: 2, measuredAt: new Date().toISOString(),
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, cores: cpus().length, loadAverage: load, loadAverageAfter: loadavg() },
  legs, protocol: { rounds, durationMs, warmupMs, order: "A B, then B A, alternating per round, in one process per input set and syntax", aggregation: "median ms per pass over the whole set; ratio = candidate / base",
    memory: "one process per build; retained: heap one pass's documents keep alive; peak: highest heap above a collected baseline during one pass" },
  results }, null, 2));
