# Future parser and performance exploration

Expressmark currently keeps markdown-it as an internal Markdown engine. Parseman
recognizes Expressive Markdown identifiers, mention handles and attribute tokens.
This is the current implementation boundary, not a complete Parseman grammar.
There is no supported parser-plugin API. Most application customization should
use standard semantic types, attributes and per-node HTML transformers.

This note is a research backlog for agents. It authorizes no dependency migration,
new public extension contract, or specification change by itself. Start future
work from the current source and the owner's task, rather than treating these
questions as approved implementation requirements.

## Compare speed before replacing the engine

Use the reproducible suite in [benchmarks](../benchmarks/README.md). Keep raw
results, exact dependency versions, source revision/digest, Node version, CPU,
fixture hashes, warmup, samples, and aggregation with each reported comparison.
Run competitors sequentially on the same machine; do not benchmark while another
agent is running a competing workload. Use a separate Git worktree for a baseline
and reuse the dependency install where dependencies do not change. Remove trial
worktrees once their results are saved.

Compare operations separately:

| Operation | Comparison boundary |
| --- | --- |
| Markdown → AST/tokens | Include Expressmark's AST conversion; disclose competitors' different output structures |
| AST → Markdown | Preparse each implementation's own AST outside the timed region; include normal validation |
| Markdown → Markdown | Time parsing and writing together |
| Markdown → HTML | Treat as a separate operation; disclose HTML filtering and renderer differences |
| Startup | Include import, grammar construction and first parse separately from warm throughput |

Use tiny documents, ordinary guides, long documents, tables, nested lists,
references, rich HTML, code-heavy content, and malformed/adversarial input.
CommonMark-only fixtures support cross-library comparisons. Keep GFM and
Expressive Markdown workloads separate unless every compared engine implements
the same features and output obligations. Extend the current small suite before
using its results as a broad parser ranking.

Start with markdown-it, Marked, CommonMark.js and the micromark/mdast ecosystem.
Recheck which libraries and versions are relevant at execution time. The current
writer comparison uses mdast-util-to-markdown; add other maintained Markdown
writers only when their input/output contracts are comparable. HTML-to-Markdown
converters perform a different task.

Profile attributable cost before optimizing: parser construction, rule setup,
inline parsing, token-to-AST conversion, attribute recognition, HTML filtering,
writer validation and escaping. Measure representative latency, throughput,
memory and shipped size together. Record regressions by workload instead of
hiding them in one average. Avoid caches that make repeated-input benchmarks
look fast while changing mutation, diagnostics or memory behavior.

An Expressmark parse includes work after markdown-it tokenization. Beating the
underlying engine's raw tokenization is not an assumed success condition. Claims
such as “fastest Markdown parser” require a defined comparison set, equivalent
work, representative inputs, and repeatable results; a single microbenchmark
cannot establish them.

## Explore a complete Parseman implementation

The alternative worth evaluating is a Parseman grammar for the **whole document**,
including ordinary Markdown. Wrapping a foreign parser, or calling Parseman for
three terminals, does not demonstrate that alternative.

Before a migration:

1. Map current block, inline, reference, delimiter, recovery, HTML and extension
   behavior to its owning tests. Include list-table structure, fence precedence,
   merged grids, identity and canonical-writing invariants.
2. Design Parseman grammar rules for recognition and identify the semantic passes
   required by context-sensitive Markdown behavior. Keep the boundary explicit;
   do not disguise an existing parser behind a Parseman entry point.
3. Build an isolated implementation against the existing AST. Check interpreted,
   runtime-compiled and build-time grammar routes available in the pinned Parseman
   version. Verify output parity and strict-CSP behavior for any shipped route.
4. Run the unchanged Expressmark regression suite and an independently sourced
   CommonMark/GFM corpus. Pin the corpus and its license. Investigate differences;
   do not rewrite expectations merely to make the new engine pass.
5. Compare the full pipeline with the incumbent. Include cold startup, warm parses,
   failure/recovery paths, memory, dependency weight and bundle size. Separate
   Parseman compilation cost from steady-state parsing.
6. Recommend migration only with documented correctness coverage and measured
   benefits. Report unsupported cases, maintenance burden, compatibility risks,
   and any improvements needed in Parseman itself.

A prototype is evidence, not permission to replace the shipped engine. Keep
public AST and converter contracts stable unless the owner approves a change.

## Preserve the author’s source form

The current semantic AST intentionally loses some syntax choices. For example,
`<em>hello</em>` and `*hello*` become the same emphasis node, and the canonical
writer emits `*hello*`. Native paragraphs can similarly become ordinary Markdown.
This behavior predates the separate HTML renderer.

For author-facing editing, investigate two distinct fidelity levels:

- **Authored form:** retain whether a node was written as HTML or Markdown, and
  determine whether the original HTML tag (`em` versus `i`, for example) matters.
  Keep one editable semantic node with separate provenance rather than creating
  two unrelated semantic types for the same content.
- **Source fidelity:** retain delimiter choices, whitespace, quote style, entity
  spelling and untouched source regions. Define what happens when a node or its
  descendants change, move, split or merge; this may require a CST or retained
  source ranges with edit tracking.

Decide the default and compatibility contract before implementing either level:
canonical writing, authored-form writing, or separate explicit modes. Check the
public proposal’s AST/source and writer rules in a specification task before
turning a research candidate into a language requirement. The existing optional
`source` field is a place to investigate, not an already-approved preservation
schema.

Keep unsafe discarded HTML discarded. Neither authored-form hints nor retained
source may replay scripts, event handlers, rejected URLs or filtered attributes.
Measure storage, parse/write cost and editor behavior, and test mixed HTML/Markdown
nesting, edits to HTML-origin nodes, newly created nodes, and sanitization. Report
which fidelity level the experiment actually preserves; semantic round-trip tests
alone do not prove source-form preservation.

## Decide whether syntax plugins are needed

First test whether an existing `container`, `inline` or `leaf` semantic subtype
plus attributes can represent the use case. Prefer ordinary syntax with
application rendering, mention resolution, styling or interaction supplied later.
Open semantic names should remove most pressure to invent parser plugins.

If a real use case still requires new syntax, establish what the language permits
before defining an Expressmark plugin system. The normative proposal lives in
[`nextwebwg/specs`](https://github.com/nextwebwg/specs), published at
https://nextwebwg.org/expressive-markdown/. Extension syntax, precedence, conflicts,
fallback behavior and validity belong there. Discuss those questions in a
separate specification task; this tooling repository must not acquire a parallel
specification or support profile.

A markdown-it plugin being installable does not prove semantic compatibility with
Expressmark's AST, safe HTML policy or canonical writer. Plugins that emit only
HTML may discard editable structure. CommonJS/ESM interoperability and type
availability are additional compatibility checks, not reasons to expose the
underlying engine as a public contract.

## Leave a useful research result

Record the question, exact baseline, candidate implementation, correctness
coverage, commands, raw measurements, workload regressions and recommendation.
Separate observed facts from hypotheses and proposals. State what evidence would
change the recommendation. Keep public examples free of private consumer context.
