# Changelog

## 0.1.7

- Parse, write and render footnotes. `[^label]` references a `[^label]:`
  definition whose indented continuation holds any blocks. Definitions live in
  `document.footnotes`, ordered by first reference, with unused notes after them
  in source order; `stringify` writes them after the body in that order.
- Record each definition's source `position` and original Markdown in `source`.
  `stringify(document, { preserveSource: true })` writes an unedited definition
  back where it was authored; an edited one moves to the canonical place.
- Keep an undefined reference as text, and keep a repeated definition as text in
  place so the first definition stays the note. Report undefined, unused and
  repeated footnotes as diagnostics.
- Render references as numbered superscript links and the notes as a labelled
  `<section data-footnotes>` list with a back-link to every reference.
- Read container, leaf, table and document titles after the block pass, so a
  title can refer to a note defined later in the document.

## 0.1.6

- Keep ordinary punctuation readable during Markdown export, including bracketed
  ranges, braces, comparisons, pipes, unmatched delimiters and `a@word`. Protect
  literal syntax according to its block, inline and adjacent-node context.
- Require whitespace or the start of inline source before a mention. Preserve
  authored mention nodes at other boundaries through semantic HTML.
- Keep unmatched backticks literal in directive labels, respect code-span
  delimiters, and use the correct punctuation context for YAML document titles.
- Preserve literal backslashes when they could expose syntax or consume generated
  formatting and label delimiters.

## 0.1.5

- Use logical `start`, `center` and `end` table alignment in source settings,
  AST values and HTML metadata round trips. Normalize GFM alignment markers
  to the same logical values and reject physical `left`/`right` settings.

## 0.1.4

- Recognize mentions exclusively through `@` syntax. The replaced `:mention`
  directive form remains ordinary Markdown text, including case variants and
  attribute-only forms. Preserve mention labels, references and occurrence IDs
  when writing the canonical `@` form.
- Explain rich document capture and readable Markdown round trips in the README.

## 0.1.3

- Keep simple named table cells on the same line as their field names while
  retaining indented bodies for rich or multiline cells.

- Write ordinary prose colons without backslashes while preserving literal text
  that could otherwise become directive syntax.
- Keep intraword underscores and email link labels readable while protecting
  explicitly plain URL and email text from becoming unintended links.
- Write simple link and image destinations without unnecessary angle brackets;
  retain delimiters for destinations that need them.

## 0.1.2

- Render layout containers with logical alignment and whole-group floating;
  verify block placement, text alignment and surrounding flow in Arabic, Hebrew
  and English across Chromium, Firefox and WebKit.
- Add the separate `expressmark/render` HTML renderer with per-node and semantic
  subtype overrides, default rendering helpers and shared output filtering.
- Reuse parsed inline tokens during AST conversion instead of parsing ordinary
  paragraph and heading content twice.
- Add reproducible Markdown benchmarks, a visual README, Conductor scripts and
  an agent-facing backlog for Parseman and performance exploration.

- Parse and write the list-based table syntax: named column identities, mixed
  positional records, rich cell bodies, headers, transposition, alignment and
  rectangular merges. Preserve malformed tables as whole-source recovery nodes.
- Keep code and HTML boundaries intact while locating nested container fences.
- Add GFM-oriented parser and round-trip coverage for ordinary Markdown, tables,
  tasks, strikethrough, autolinks and Expressive Markdown precedence.
- Recognize `www.` autolinks, preserve nested-list tightness, and escape literal
  numbered list markers during writing.

## 0.1.1

- Preserve spaces inside formatting, adjacent and nested marks, empty paragraphs,
  and literal character-reference text when writing and reparsing documents.

## 0.1.0

- Add synchronous `parse` and `stringify`, document AST types and recoverable diagnostics.
- Support metadata, shared attributes, mentions, nested containers, tabs, line blocks,
  merged tables and safe rich HTML import/export alongside ordinary Markdown.
- Filter active HTML and unsafe native presentation on both conversion boundaries.
- Reject unsupported AST conversions instead of silently losing content.

## 0.0.2

- Move the package to `nextwebwg/expressmark`, with independent pnpm 12, TypeScript 7,
  Oxlint, Vitest, parseman tooling and protected publishing. Update npm's source links.
- Keep the reservation's empty public API; parsing and writing are not implemented.

## 0.0.1

- Reserve `expressmark` and establish its ESM and TypeScript package with no public API.
