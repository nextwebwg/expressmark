# Expressmark comparison suite

Measure Markdown parsing, writing and round trips against pinned implementations.
The suite also records reference Markdown-to-HTML pipelines. It makes no universal
“fastest parser” claim: libraries return different structures and implement
different extension, validation and filtering policies.

## Run it

From the repository root, use a supported Node LTS release and Corepack:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm --dir benchmarks --ignore-workspace install --frozen-lockfile
node benchmarks/run.mjs > results.json
```

The benchmark package is private, has its own lockfile, and adds no dependencies
to Expressmark's runtime. Timings are intentionally outside `verify:pr`; shared CI
machines are unsuitable for tight speed thresholds.

`BENCH_SAMPLES` defaults to 7 and must be an integer of at least 3.
`BENCH_DURATION_MS` defaults to 100 and must be at least 10. `BENCH_SYNTAX` sets the syntax the expressmark tasks parse and write with, `compatible` (the default) or `standard`. For another built
checkout, set `BENCH_EXPRESSMARK_ROOT` to its absolute path. This lets the same
suite compare baseline and candidate worktrees without copying a repository or
installing dependencies separately in each one.

```sh
BENCH_EXPRESSMARK_ROOT=/absolute/path/to/baseline node benchmarks/run.mjs > before.json
node benchmarks/run.mjs > after.json
node benchmarks/report.mjs after.json
```

Run sequentially on an otherwise idle machine. Do not overlap benchmark runners
or other agents' CPU-intensive work. Capture more independent paired runs before
interpreting small differences. A wider corpus is needed for broad performance
conclusions; see [future exploration](../docs/future-exploration.md).

## What is compared

| Operation | Implementations | Timed work |
| --- | --- | --- |
| Parse | Expressmark, markdown-it, Marked, CommonMark.js, mdast | Markdown → each library's AST or tokens |
| Stringify | Expressmark, mdast-util-to-markdown | Each library's prebuilt AST → Markdown |
| Round trip | Expressmark, mdast | Markdown → AST → Markdown |
| Reference HTML pipelines | markdown-it, Marked, CommonMark.js, micromark | Markdown → HTML, as a separate operation |

The common fixtures use CommonMark syntax. markdown-it uses its `commonmark`
preset; Marked has GFM disabled. Expressmark retains its normal extension and HTML
policies. Its parse timings include construction/configuration of a fresh parser
and conversion to the public document AST. Competitor parser objects are reused,
matching typical standalone use. This is a comparison of public operations, not
an isolated algorithm benchmark.

The Expressive fixture runs **only Expressmark**: containers, metadata, mentions,
tabs, a GFM table and safe HTML are not equivalent grammars across the competitors.
Reference HTML figures do not rank AST parsers and do not include Expressmark's
separate filtered renderer. HTML-to-Markdown libraries are not included as
Markdown serializers.

## Protocol and checks

Each task gets a 30 ms warmup, followed by seven timed samples of at least 100 ms.
Order rotates between samples; execution is sequential. Results report the median,
minimum, maximum, operations per second, and every individual sample. A slow single
operation can extend a sample past its target duration. Setup and AST creation
for writer-only measurements are outside timing; normal writer validation stays
inside it. These are warm-process timings, not import/startup measurements.

Before timing, the runner checks nonempty output and canonical Expressmark
round-trip stability. After timing, it checks that both writers left their input
ASTs unchanged. These smoke checks do not establish equivalent ASTs or full
CommonMark/GFM conformance; the regression suite owns current behavior.

JSON output records the CPU, platform, Node version, dependency versions,
source revision and implementation digest, working-tree status, input sizes,
fixture digest, and protocol. Keep these fields when sharing results. See
[recorded measurements](results/README.md) for this change's evidence.
