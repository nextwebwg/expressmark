import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus, platform, arch } from "node:os";
import { performance } from "node:perf_hooks";
import MarkdownIt from "markdown-it";
import { marked } from "marked";
import * as commonmark from "commonmark";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { micromark } from "micromark";
const targetRoot = new URL(process.env.BENCH_EXPRESSMARK_ROOT ? `${process.env.BENCH_EXPRESSMARK_ROOT.replace(/\/$/, "")}/` : "../", import.meta.url);
const { parse, stringify } = await import(new URL("dist/index.js", targetRoot));

const samples = Number(process.env.BENCH_SAMPLES ?? 7);
const durationMs = Number(process.env.BENCH_DURATION_MS ?? 100);
assert(Number.isInteger(samples) && samples >= 3, "BENCH_SAMPLES must be an integer >= 3");
assert(Number.isFinite(durationMs) && durationMs >= 10, "BENCH_DURATION_MS must be >= 10");
const readFixture = name => readFileSync(new URL(`./fixtures/${name}.md`, import.meta.url), "utf8");
const prose = readFixture("prose");
const fixtures = [
  { name: "short", source: "# Hello\n\nA **small** document with a [link](https://example.com).\n", common: true },
  { name: "guide", source: prose, common: true },
  { name: "long-guide", source: prose.repeat(64), common: true },
  { name: "expressive", source: readFixture("expressive"), common: false },
];
const markdownIt = new MarkdownIt("commonmark");
const commonmarkParser = new commonmark.Parser();
const commonmarkRenderer = new commonmark.HtmlRenderer();
const markedOptions = { gfm: false };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let sink;
function measure(run, milliseconds) {
  let count = 0;
  const start = performance.now();
  do { sink = run(); count++; } while (performance.now() - start < milliseconds);
  return (performance.now() - start) * 1000 / count;
}
const results = [];
for (const fixture of fixtures) {
  const { source } = fixture;
  const doc = parse(source);
  assert.equal(doc.type, "document");
  const original = JSON.stringify(doc);
  const canonical = stringify(doc);
  assert.equal(stringify(parse(canonical)), canonical, `${fixture.name}: canonical round trip changed`);
  const tasks = [
    { operation: "parse", library: "expressmark", run: () => parse(source) },
    { operation: "stringify", library: "expressmark", run: () => stringify(doc) },
    { operation: "round-trip", library: "expressmark", run: () => stringify(parse(source)) },
  ];
  let checkMdast = () => {};
  if (fixture.common) {
    const mdast = fromMarkdown(source);
    const mdastOriginal = JSON.stringify(mdast);
    tasks.push(
      { operation: "parse", library: "markdown-it", run: () => markdownIt.parse(source, {}) },
      { operation: "parse", library: "marked", run: () => marked.lexer(source, markedOptions) },
      { operation: "parse", library: "commonmark", run: () => commonmarkParser.parse(source) },
      { operation: "parse", library: "mdast", run: () => fromMarkdown(source) },
      { operation: "stringify", library: "mdast", run: () => toMarkdown(mdast) },
      { operation: "round-trip", library: "mdast", run: () => toMarkdown(fromMarkdown(source)) },
      { operation: "to-html", library: "markdown-it", run: () => markdownIt.render(source) },
      { operation: "to-html", library: "marked", run: () => marked.parse(source, markedOptions) },
      { operation: "to-html", library: "commonmark", run: () => commonmarkRenderer.render(commonmarkParser.parse(source)) },
      { operation: "to-html", library: "micromark", run: () => micromark(source) },
    );
    checkMdast = () => assert.equal(JSON.stringify(mdast), mdastOriginal, "writer mutated the mdast input");
  }
  for (const task of tasks) {
    const result = task.run();
    assert(result && (typeof result !== "string" || result.length), `${task.library}: empty result`);
    measure(task.run, 30);
    task.timings = [];
  }
  // Rotate competitors between samples to spread JIT and temperature effects.
  // Calls remain sequential; setup and fixture parsing for writers are untimed.
  for (let sample = 0; sample < samples; sample++) {
    for (let offset = 0; offset < tasks.length; offset++) {
      const task = tasks[(offset + sample) % tasks.length];
      task.timings.push(measure(task.run, durationMs));
    }
  }
  assert.equal(JSON.stringify(doc), original, "writer mutated the input AST");
  checkMdast();
  for (const task of tasks) {
    const us = median(task.timings);
    results.push({ fixture: fixture.name, bytes: Buffer.byteLength(source), operation: task.operation,
      library: task.library, medianUs: us, opsPerSecond: 1e6 / us,
      minUs: Math.min(...task.timings), maxUs: Math.max(...task.timings), samplesUs: task.timings });
  }
}
assert(sink !== undefined);
const versions = Object.fromEntries(["markdown-it", "marked", "commonmark", "mdast-util-from-markdown", "mdast-util-to-markdown", "micromark"].map(name => [name, JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), "utf8")).version]));
const git = args => execFileSync("git", args, { cwd: targetRoot, encoding: "utf8" }).trim();
console.log(JSON.stringify({ schemaVersion: 1, measuredAt: new Date().toISOString(),
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  source: { commit: git(["rev-parse", "HEAD"]), dirty: !!git(["status", "--porcelain"]),
    implementationSha256: createHash("sha256").update(["parse.ts", "stringify.ts", "grammar.ts", "html.ts", "tables.ts"].map(name => readFileSync(new URL(`src/${name}`, targetRoot), "utf8")).join("\0")).digest("hex"),
    fixtureSha256: createHash("sha256").update(fixtures.map(f => f.source).join("\0")).digest("hex") },
  versions, protocol: { samples, durationMs, warmupMs: 30, aggregation: "median", order: "rotating, sequential" }, results }, null, 2));
