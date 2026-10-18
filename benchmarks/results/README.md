# Recorded measurements

Measured on 2026-10-18 with Node 24.20.0 on an Apple M4 Pro (macOS arm64).
Each run used seven samples per task, at least 100 ms per sample, and a 30 ms
warmup. The runner executed sequentially. Two baseline/candidate pairs were run.

The baseline is `7d0283f`, before AST conversion began reusing inline tokens.
Candidate source is identified by `implementationSha256` in each raw JSON file;
the candidate had uncommitted changes when measured. This improvement removes
a second inline parse from ordinary paragraphs and unattached headings. It also
prevents duplicate inline-attribute diagnostics.

## Parse change across both runs

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

## Candidate comparisons, second run

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

## Raw evidence

- [Baseline, run 1](node24-m4-before-1.json) / [candidate, run 1](node24-m4-after-1.json)
- [Baseline, run 2](node24-m4-before-2.json) / [candidate, run 2](node24-m4-after-2.json)

Regenerate tables for any JSON result with `node benchmarks/report.mjs <file>`.
Keep complete raw files when comparing future implementations.
