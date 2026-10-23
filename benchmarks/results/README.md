# Recorded measurements

## Parseman reader against markdown-it, 0.1.19

Measured on 2026-10-23 with Node 24.11.1 on an Apple M4 Pro (macOS arm64) by
`compare.mjs`: base `204fc28` (0.1.18, markdown-it 15.0.3) against candidate
`f1e44cb` (0.1.19, Parseman 0.55.3), 21 interleaved rounds per input set and
syntax, each run at least 200 ms after a 500 ms warmup. Other sessions kept the
one-minute load average at 10–11 throughout; base and candidate alternate in
one process, so both see the same load. Every parsed document is identical
between the two builds.

| Input set | Syntax | Documents | markdown-it ms | Parseman ms | Ratio (round range) | Retained MB, base → candidate | Peak MB, base → candidate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fixtures | compatible | 5 | 21.60 | 18.47 | 0.855× (0.262–1.691) | 3.92 → 1.88 | 11.95 → 19.00 |
| fixtures | modern | 5 | 21.24 | 17.78 | 0.837× (0.738–1.239) | 1.87 → 1.87 | 36.77 → 17.64 |
| CommonMark 0.31.2 | compatible | 652 | 16.48 | 6.68 | 0.405× (0.369–0.438) | 0.73 → 0.68 | 32.86 → 19.59 |
| CommonMark 0.31.2 | modern | 652 | 17.81 | 7.55 | 0.424× (0.397–0.457) | 0.75 → 0.84 | 32.59 → 21.51 |
| GFM 0.29 | compatible | 672 | 19.36 | 7.98 | 0.412× (0.376–0.436) | 0.80 → 0.80 | 32.97 → 21.12 |
| GFM 0.29 | modern | 672 | 20.76 | 8.48 | 0.409× (0.391–0.476) | 0.81 → 0.81 | 33.15 → 22.45 |
| READMEs | compatible | 398 | 994.11 | 791.99 | 0.797× (0.750–0.836) | 56.33 → 56.26 | 147.75 → 157.84 |
| READMEs | modern | 398 | 1702.33 | 917.59 | 0.539× (0.478–0.577) | 61.11 → 61.12 | 182.58 → 215.19 |

Milliseconds are the median time to parse every document of the set once. The
retained heap is what one pass's documents keep alive; peak is the highest heap
a pass reaches above a collected baseline, sampled after each document, and it
moves with collector timing, so it is indicative only. Retained heap moves by up
to 0.4 MB between two runs of one build on the small sets.

An A/A control, base against itself at a load average of 2, read ratios of
0.975–1.017 on every set (round ratios 0.923–1.064): differences inside that
band are noise.

The small sets gain most from readers built once per rule set, with the link
detector compiled once. The README corpus in `modern` syntax also gains from
reading an HTML element's code spans in time linear in the element. Recording
the source for exact writing costs about 9% of README parse time in both builds.

Cold start (import and a first one-line parse, median of seven processes):
58.9 ms and 5.9 ms for the base, 57.4 ms and 6.1 ms for the candidate.
Shipped JavaScript: `dist` is 363 KB (86 KB gzip) against 269 KB (65 KB gzip),
and markdown-it's 119 KB (28 KB gzip) module leaves the dependency tree.

## Inline token reuse, 0.1.x

Measured on 2026-10-18 with Node 24.20.0 on an Apple M4 Pro (macOS arm64).
Each run used seven samples per task, at least 100 ms per sample, and a 30 ms
warmup. The runner executed sequentially. Two baseline/candidate pairs were run.

The baseline is `7d0283f`, before AST conversion began reusing inline tokens.
Candidate source is identified by `implementationSha256` in each raw JSON file;
the candidate had uncommitted changes when measured. This improvement removes
a second inline parse from ordinary paragraphs and unattached headings. It also
prevents duplicate inline-attribute diagnostics.

### Parse change across both runs

| Fixture | Bytes | Run 1 reduction in time/op | Run 2 reduction in time/op |
| --- | ---: | ---: | ---: |
| short | 66 | -1.4% | 7.3% |
| guide | 1477 | 22.4% | 22.2% |
| long-guide | 94528 | 43.8% | 34.3% |
| expressive | 491 | 9.8% | 7.6% |

Positive values mean less elapsed time per operation. Tiny-input results vary
around the baseline; they do not establish a reliable improvement. Guide and
long-guide parsing improved in both runs. Unchanged writer timings also moved
between runs, so small differences should be treated as noise.

### Candidate comparisons, second run

Median microseconds per operation; lower is better. See the suite README for
output-contract and parser-construction differences.

| Fixture | Expressmark parse | markdown-it tokens | Marked tokens | CommonMark AST | mdast AST |
| --- | ---: | ---: | ---: | ---: | ---: |
| short | 126.19 | 6.84 | 3.76 | 1.72 | 35.85 |
| guide | 179.25 | 44.78 | 37.28 | 14.99 | 318.73 |
| long-guide | 4783.81 | 3011.79 | 2352.77 | 994.95 | 36623.38 |

| Fixture | Expressmark write | mdast write | Expressmark round trip | mdast round trip |
| --- | ---: | ---: | ---: | ---: |
| short | 26.85 | 33.69 | 154.87 | 69.57 |
| guide | 147.15 | 161.57 | 349.70 | 499.52 |
| long-guide | 9774.00 | 11339.65 | 14912.08 | 43282.29 |

Expressmark is slower than markdown-it, Marked and CommonMark.js in these parse workloads.
It parses the guide and long guide faster than mdast in this run, and its writer
is faster than the measured mdast writer on these fixtures. This is not a ranking
across all Markdown workloads or serializers. The libraries do different work,
and only one external Markdown writer is measured.

### Raw evidence

- [Baseline, run 1](node24-m4-before-1.json) / [candidate, run 1](node24-m4-after-1.json)
- [Baseline, run 2](node24-m4-before-2.json) / [candidate, run 2](node24-m4-after-2.json)

Regenerate tables for any JSON result with `node benchmarks/report.mjs <file>`.
Keep complete raw files when comparing future implementations.
