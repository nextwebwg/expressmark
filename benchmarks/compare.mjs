// Parse the same input sets with two expressmark checkouts, interleaving their
// runs so both see the same machine load, and report parse time, memory and
// whether their outputs agree.
// Usage: node benchmarks/compare.mjs --base=<path-or-git-ref> [--candidate=<path>] > results.json
//
// Each round runs one child process per checkout, base then candidate (A B A B
// …), so neither build shares a process, a heap or a JIT with the other, and
// both see the same machine load. Memory runs in one child process per build.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { arch, cpus, loadavg, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { checkouts } from "./checkout.mjs";
import { digest, inputSet, setNames } from "./corpus.mjs";

const list = (value, all) => value ? value.split(",").map(item => item.trim()).filter(Boolean) : all;
const rounds = Number(process.env.BENCH_ROUNDS ?? 21);
const durationMs = Number(process.env.BENCH_DURATION_MS ?? 200);
const warmupMs = Number(process.env.BENCH_WARMUP_MS ?? 500);
const peakOrders = Number(process.env.BENCH_PEAK_ORDERS ?? 5);
assert(Number.isInteger(rounds) && rounds >= 4, "BENCH_ROUNDS must be an integer >= 4");
assert(durationMs >= 10 && warmupMs >= 0, "BENCH_DURATION_MS must be >= 10");
const optionsFor = syntax => ({ syntax });
const median = values => { const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1; return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; };

// A list's recorded item ranges extend a block's source entry; the first five
// fields of each entry are what every version records.
const comparable = document => Array.isArray(document.source?.blocks) ? { ...document, source: { ...document.source, blocks: document.source.blocks.map(entry => entry.slice(0, 5)) } } : document;
function passes(parse, documents, options) {
  return () => { let last; for (const source of documents) { try { last = parse(source, options); } catch { /* reported with the outputs */ } } return last; };
}
let sink;
const timed = (pass, milliseconds) => { let count = 0; const start = performance.now(); do { sink = pass(); count++; } while (performance.now() - start < milliseconds); return (performance.now() - start) / count; };

if (process.argv[2] === "--time") {
  const [, , , setName, syntax, entry, hashes] = process.argv;
  const documents = await inputSet(setName), options = optionsFor(syntax);
  const { parse } = await import(entry);
  const outputs = hashes === "hashes" ? documents.map(source => {
    try { return createHash("sha1").update(JSON.stringify(comparable(parse(source, options)))).digest("hex"); }
    catch (error) { return `threw: ${error instanceof Error ? error.message : String(error)}`; }
  }) : undefined;
  const run = passes(parse, documents, options);
  timed(run, warmupMs);
  const ms = timed(run, durationMs);
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
  // Peak: the highest heap one pass reaches above a collected baseline. Where
  // the collector runs depends on the order of the documents, so the peak is the
  // median over passes in several fixed shuffled orders.
  const peaks = [];
  for (let seed = 1; seed <= peakOrders; seed++) {
    let x = seed;
    const random = () => ((x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + 0x9e3779b9 | 0) >>> 0) / 4294967296;
    const order = documents.map(source => [random(), source]).sort((a, b) => a[0] - b[0]).map(([, source]) => source);
    const base = collect(); let peak = 0;
    for (const source of order) { try { parse(source, options); } catch { /* reported with the outputs */ } peak = Math.max(peak, process.memoryUsage().heapUsed - base); }
    peaks.push(peak);
  }
  const peak = median(peaks);
  console.log(JSON.stringify({ retainedBytes: retained, peakBytes: peak, peaksBytes: peaks, released: kept === undefined }));
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
  const ms = legs.map(() => []);
  let first;
  for (let round = 0; round < rounds; round++) {
    const sides = legs.map(leg => child("--time", set, syntax, leg.entry, round === 0 ? "hashes" : ""));
    first ??= sides;
    sides.forEach((side, leg) => ms[leg].push(side.ms));
  }
  const timing = { ...first[0], outputs: first.map(side => side.outputs) };
  const memory = legs.map(leg => child("--memory", set, syntax, leg.entry));
  const [base, candidate] = ms;
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
  legs, protocol: { rounds, durationMs, warmupMs, order: "A B A B: each round runs one child process per checkout, base then candidate", aggregation: "median ms per pass over the whole set; ratio = candidate / base",
    memory: "one process per build; retained: heap one pass's documents keep alive; peak: median over BENCH_PEAK_ORDERS passes in fixed shuffled orders of the highest heap above a collected baseline" },
  results }, null, 2));
