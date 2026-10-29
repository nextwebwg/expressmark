# Recorded measurements

## Line runs, bare URLs and incremental parsing, 0.4.0

Measured on 2026-10-28 with Node 24.11.1 on an Apple M4 Pro (macOS arm64) by
`compare.mjs`: base `ac43594` (0.3.0, Parseman 0.55.3) against candidate
`378ebaa` (0.4.0, Parseman 0.56.0), 21 rounds per input set and syntax. Each
round runs one child process per checkout, base then candidate, each timing
whole passes for at least 200 ms after a 500 ms warmup. The one-minute load
average was 4.9–7.6 from other sessions. Every parsed document is identical
between the two builds, comparing the five fields of each source block entry
that both versions record.

| Input set | Syntax | Documents | 0.3.0 ms | 0.4.0 ms | Ratio (round range) | Retained MB, base → candidate | Peak MB, base → candidate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fixtures | compatible | 5 | 17.47 | 17.34 | 0.993× (0.931–1.133) | 1.88 → 1.93 | 18.51 → 49.94 |
| fixtures | standard | 5 | 17.61 | 17.16 | 0.975× (0.585–1.027) | 1.87 → 1.91 | 62.91 → 48.58 |
| CommonMark 0.31.2 | compatible | 652 | 7.02 | 7.47 | 1.064× (0.876–1.580) | 0.73 → 0.78 | 19.35 → 19.40 |
| CommonMark 0.31.2 | standard | 652 | 7.89 | 8.55 | 1.083× (0.927–1.186) | 0.75 → 1.24 | 21.21 → 22.39 |
| GFM 0.29 | compatible | 672 | 8.15 | 7.59 | 0.931× (0.762–1.044) | 0.80 → 0.85 | 20.62 → 20.64 |
| GFM 0.29 | standard | 672 | 9.24 | 8.70 | 0.942× (0.874–1.042) | 0.81 → 1.16 | 21.93 → 23.07 |
| READMEs | compatible | 397 | 819.55 | 832.44 | 1.016× (0.865–1.278) | 56.45 → 58.15 | 124.95 → 147.24 |
| READMEs | standard | 397 | 972.37 | 1030.40 | 1.060× (0.959–1.547) | 60.62 → 62.64 | 142.46 → 175.17 |

An earlier run of the same protocol on the same day, with the candidate one
commit before (Parseman at the 0.56.0 release commit, linked locally), read
0.891× and 1.016× on CommonMark, 0.885× and 0.930× on GFM, and 0.992× and
1.030× on the README corpus: differences of a few percent on these sets move
between runs at this load.

Peak is now the median, over five passes in fixed shuffled document orders, of
the highest heap a pass reaches above a collected baseline. Where the
collector runs depends on the order of the documents: in seven orders the
README corpus in `standard` syntax peaks at 126–176 MB with 0.2.2, 132–168 MB
with 0.3.0 and 144–181 MB with 0.4.0. One pass over that corpus allocates
1.68 GB in 0.4.0 and 1.62 GB in 0.3.0. A heap snapshot of a quarter of the
corpus holds 44.07 MB of parsed documents with 0.3.0 and 44.47 MB with 0.4.0,
the difference being each top-level list's recorded item ranges.

Peak follows allocation and collector timing, so it overstates the heap a
build needs. The smallest `--max-old-space-size` under which three passes over
the README corpus complete, found by bisection to 2 MB:

| Syntax | Documents discarded, 0.3.0 → 0.4.0 | All documents kept, 0.3.0 → 0.4.0 |
| --- | ---: | ---: |
| `compatible` | 49 → 47 MB | 108 → 110 MB |
| `standard` | 49 → 47 MB | 112 → 114 MB |

`incremental.mjs` timed a one-character edit at nine positions in prose lines
of the corpus's largest README (426,115 bytes, 4,161 lines), 21 rounds, full
parse and edit alternating order per round:

| Syntax | Full parse median ms (Q1–Q3) | Edit median ms (Q1–Q3) | Ratio | Round ratios |
| --- | ---: | ---: | ---: | ---: |
| compatible | 37.411 (36.507–39.387) | 0.936 (0.863–1.021) | 0.0250× | 0.0188–0.0352 |
| standard | 39.385 (37.365–40.332) | 1.018 (0.883–1.158) | 0.0258× | 0.0186–0.0341 |

## Parseman reader against markdown-it, 0.3.0

Measured on 2026-10-28 with Node 24.11.1 on an Apple M4 Pro (macOS arm64) by
`compare.mjs`: base `1ecaae0` (0.2.2, markdown-it 15.0.3) against candidate
`8b02b1a` (0.3.0, Parseman 0.55.3), 21 interleaved rounds per input set and
syntax, each run at least 200 ms after a 500 ms warmup. Other sessions kept the
one-minute load average at 11–14 throughout; base and candidate alternate in
one process, so both see the same load. Every parsed document is identical
between the two builds.

| Input set | Syntax | Documents | markdown-it ms | Parseman ms | Ratio (round range) | Retained MB, base → candidate | Peak MB, base → candidate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fixtures | compatible | 5 | 22.27 | 19.06 | 0.856× (0.582–1.470) | 1.88 → 1.88 | 37.69 → 19.45 |
| fixtures | standard | 5 | 20.45 | 17.07 | 0.835× (0.755–0.897) | 2.23 → 2.10 | 36.35 → 17.13 |
| CommonMark 0.31.2 | compatible | 652 | 16.22 | 6.72 | 0.415× (0.328–0.480) | 0.73 → 0.70 | 32.82 → 19.69 |
| CommonMark 0.31.2 | standard | 652 | 17.85 | 7.67 | 0.430× (0.410–0.510) | 0.75 → 0.75 | 32.59 → 21.55 |
| GFM 0.29 | compatible | 672 | 18.53 | 7.33 | 0.395× (0.363–0.435) | 1.19 → 0.80 | 24.90 → 21.09 |
| GFM 0.29 | standard | 672 | 22.26 | 10.23 | 0.460× (0.327–0.618) | 0.65 → 1.17 | 17.04 → 22.35 |
| READMEs | compatible | 398 | 1044.16 | 820.32 | 0.786× (0.717–0.901) | 56.33 → 56.27 | 145.34 → 157.58 |
| READMEs | standard | 398 | 1758.02 | 984.29 | 0.560× (0.493–0.683) | 60.91 → 60.88 | 141.75 → 204.88 |

Milliseconds are the median time to parse every document of the set once. The
retained heap is what one pass's documents keep alive; it moves by up to 0.5 MB
between runs of one build on the small sets. Peak is the highest heap a pass
reaches above a collected baseline, sampled after each document; it follows the
collector's timing and is indicative only.

An A/A control, 0.1.18 against itself at a load average of 2, read ratios of
0.975–1.017 on every set (round ratios 0.923–1.064): differences inside that
band are noise.

The small sets gain most from readers built once per rule set, with the link
detector compiled once. The README corpus in `standard` syntax also gains from
reading an HTML element's code spans in time linear in the element. Recording
the source for exact writing costs about 9% of README parse time in both builds.

Cold start (import and a first one-line parse, median of seven processes, on
0.1.18 against this reader): 58.9 ms and 5.9 ms against 57.4 ms and 6.1 ms.
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
