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

## Compare two checkouts

`compare.mjs` measures two built expressmark checkouts on the same inputs:
`--base=<path-or-git-ref>` names the base, and the candidate is this checkout
unless `--candidate=<path>` names another. A git ref becomes a detached worktree
under the ignored `work/` directory, installed through the shared pnpm store.

```sh
git worktree add --detach ../expressmark-bench-base origin/main
(cd ../expressmark-bench-base && corepack pnpm install --frozen-lockfile && corepack pnpm build)
corepack pnpm build
node benchmarks/compare.mjs --base=../expressmark-bench-base > benchmarks/work/compare.json
node benchmarks/report.mjs benchmarks/work/compare.json
```

The input sets are the fixtures below, CommonMark 0.31.2's 652 examples and GFM
0.29's 672, downloaded once into `work/spec/` and checked against pinned digests,
and a README corpus read from `BENCH_READMES` (default `work/readmes/`).
`readme-corpus.txt` lists the 400 public repositories the 398-file corpus came
from; their READMEs are third-party text and stay out of the repository.

For each input set and syntax, every round runs one child process per
checkout, base then candidate (A B A B …), for `BENCH_ROUNDS` rounds (default
21), so the builds never share a process, heap or JIT. Each process warms up
for `BENCH_WARMUP_MS` (default 500), then repeats whole passes over the set for
at least `BENCH_DURATION_MS` (default 200) and reports the mean pass time. The
report gives each side's median, quartiles and range, the overall ratio of medians, and the per-round ratios. Memory is
measured in one child process per build: the heap one pass's documents keep
alive, and the highest heap a pass reaches. Where the collector runs depends on
the order of the documents, so the peak is the median over `BENCH_PEAK_ORDERS`
passes (default 5) in fixed shuffled orders. The runner also hashes every parsed
document and reports how many differ between the builds. It warns when the
one-minute load average is above 3; run it on an idle machine.

`parity.mjs` takes the same `--base` and `--candidate` and compares everything a
caller observes: the parsed document, its diagnostics with and without lint,
its exact writing and its canonical writing, in both syntaxes and both HTML
profiles. It compares the first five fields of each recorded source block,
which every version records. It exits non-zero on any difference.

`incremental.mjs` times a one-character edit in the corpus's largest README
(or `BENCH_INCREMENTAL_FILE`): `parseDoc`'s `edit` against a full `parse` of
the edited text, in both syntaxes, alternating per round for `BENCH_ROUNDS`
rounds over `BENCH_EDITS` positions (default 9) in prose lines. It first checks
that every edit reads as a full parse does.

```sh
node benchmarks/incremental.mjs > benchmarks/work/incremental.json
node benchmarks/report.mjs benchmarks/work/incremental.json
```

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
