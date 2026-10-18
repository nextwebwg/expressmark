# Changelog

## 0.1.2

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
