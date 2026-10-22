# Changelog

## 0.1.14

- Open a container for every colon fence. A header without a type, such as
  `::: {.render}`, `::: [Title]` or a bare `:::`, gives a generic container
  with no `subType`, rendered as a `<div>` with its attributes. An unreadable
  header keeps the type it names, with `source.rest` holding the remainder,
  and reports `invalid-container-header`.
- Keep a stray bare `:::` with no closing line as a `strayFence` node: it
  renders nothing, round-trips and reports `stray-fence`, and never encloses
  following content. A bare fence closes only before any other opening fence
  of its length or longer.
- Run an unclosed container to the end of its enclosing block, or to a longer
  fence, reporting `unclosed-container`, in place of literal recovery.
- Strip a fence's own indentation from the lines it encloses, as for code fences.
- Accept `.class` shorthand in attribute lists. Shorthands accumulate into
  `class`; an assigned `class=` replaces them, and a later list's shorthands
  add to an earlier one's. A class never becomes a container type.
  This also fixes 0.1.8's reading of `::: note Title {.x}`: the title is
  "Title" and `.x` a class.
- End a container with its enclosing block, such as a list item.
- Read bracketed spans, `[text]{attributes}`, as typeless `inline` nodes when
  the bracket is not a link, rendered as `<span>` with their attributes. Links
  and resolving references keep their lists; `![…]`, `@[…]`, `:name[…]` and
  `[^…]` keep their own readings, as does a bracket right after `]` in a
  reference form; an escaped `\!`, `\@` or `\:` leaves the bracket a span. A
  span inside link text stays inside the link. Literal span-shaped text is
  protected.
- Write IDs as `#id`, the spec's preferred spelling, unless the ID needs
  quoting; authored `id=` spellings are kept.
## 0.1.12

- Render a tight list's items without `<p>`, as CommonMark does.
- Keep an allowed valueless `hidden` attribute. sanitize-html treated it as
  non-boolean because of `hidden="until-found"`; `open`, `checked`, `disabled`
  and HTML's other boolean attributes already survived.
- Reserve no heading anchor for the document's own `id`, which is its identity
  and is written on no element.

## 0.1.11

- Write an alert's type in its authored case: `> [!NOTE]`, `> [!Note]` and
  `> [!note]` each round-trip unchanged. The authored case is recorded as
  `source.type`; an edited type is written lowercase.

## 0.1.10

- Keep the author's spelling wherever Expressive Markdown accepts more than one.
  `parse` records non-preferred forms in each node's `source`, and `stringify`
  writes them back: `_` emphasis and `__` strong, `*`/`+` bullets and `)`
  ordered markers, repeated ordered numbers, setext and closed ATX headings,
  tilde and longer fences, indented code, thematic-break characters,
  trailing-space hard breaks, `<url>` and bare autolinks, link targets and
  reference definitions as written, pipe and positional tables, explicit tab
  groups, bare mentions, longer code spans, `[X]` tasks, container headers and
  fence lengths, attribute lists, fence info, line-block layout and YAML
  frontmatter. Preferred-form documents record nothing.
- Write a recorded raw spelling only while it still reads as the node; an
  edited node is written in the preferred form.
- Write faster: field contracts are no longer rebuilt for every validated node.

## 0.1.9

- Add trusted host content for sites whose pages only their own authors write.
  `parse` and `stringify` with `trustedHtml: true` keep raw HTML verbatim as
  opaque `html` nodes. `renderHtml` takes a `trustedHtml` allowlist of
  elements, attributes, style properties and URL schemes, applied to all of
  its output. Event handlers and `javascript:` URLs stay blocked unless listed
  by name. The strict safe profile remains the default.
- Export `headingAnchors` and `anchorText`, the recommended anchor algorithm,
  and add the `headingIds` render option that writes those IDs.
- Add the `escapeText` render option, applied to every rendered text run and
  code value after the safe profile, never to raw HTML or attributes.
- Add the `title: false` render option, which leaves out the designated
  title's `<h1>` while `document.title` stays populated.

## 0.1.8

- Read alerts, `> [!type] Optional title`, as callouts: the same `container`
  node as `::: type [Title]`, with `spelling: "alert"`. Types match
  case-insensitively and keep their own names, including GitHub's `important`
  and `caution` and custom types. `stringify` writes each callout in its
  authored spelling, and the colon form for new callouts; `renderHtml` gives
  both spellings the same HTML.
- Protect literal `[!type]` text at the start of an ordinary quotation.
- Read unbracketed container titles, `::: warning Before you upgrade`, as the
  title up to any trailing attribute lists, recorded with
  `titleSpelling: "unbracketed"` and written back that way. Bracketed
  `[Title]` stays the default for new titles.

## 0.1.7

- Parse, write and render footnotes. `[^label]` refers to a `[^label]:`
  definition whose indented continuation holds any blocks. Definitions are
  `footnoteDefinition` blocks that stay where they were written, including
  duplicates and unused notes; `renderHtml` collects the first definition of
  each referenced label into one `<section data-footnotes>`, numbered by first
  reference, with a back-link to every reference.
- Keep reference-style links and images in their authored form. `[label]: url`
  definitions are `definition` blocks kept in place, and `[text][label]`,
  `[text][]` and `[label]` are `linkReference` or `imageReference` nodes with
  their `label` and `referenceType`. `renderHtml` resolves them; `stringify`
  writes them as authored. Unresolved references stay text, as in CommonMark.
- Report undefined, unused and repeated footnotes, and references a written
  document cannot resolve, as diagnostics.
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
