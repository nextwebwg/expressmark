# Changelog

## 0.3.0

- Read Markdown with Parseman. Grammars in `src/markdown/lexicon.ts` recognize
  each block start and inline construct, and the reader in `src/markdown` applies
  CommonMark's container, link and emphasis algorithms to what they recognize,
  following markdown-it 15.0.3's behavior exactly. Every document of the
  CommonMark and GFM example sets and the 398-README corpus parses, lints, writes
  and writes canonically as 0.2.2 does, in both syntaxes and both HTML profiles.
  The dependencies are Parseman 0.55.3, entities, linkify-it, mdurl, punycode.js
  and uc.micro.
- Parse in 0.80× of 0.2.2's time on the README corpus in `compatible` syntax,
  0.54× in `standard`, and about 0.41× on the CommonMark and GFM examples, whose
  short documents gain most from readers built once per rule set. See
  [the measurements](benchmarks/results/README.md).
- Read a document's pipe tables and HTML elements in time linear in its length.
- Round-trip every CommonMark 0.31.2 and GFM 0.29 example byte for byte in the
  test suite, in both syntaxes.

## 0.2.2

- Keep native `<code>` content opaque to Markdown in standard syntax, like
  `<pre>`. Package scopes, emphasis markers and backticks stay literal inside
  code, while native child markup and entities retain their HTML meaning.
- Pass native `<code>` and `<pre>` text through the renderer's `escapeText`
  hook after filtering, including text inside highlighting spans. Their markup
  and attribute values stay outside the hook.

## 0.2.1

- Keep a code span beginning a named table field inline when it contains literal
  backticks. It no longer opens a block fence that swallows the table's closing
  line and following content, so literal HTML in code survives preferred writing.

## 0.2.0

- Rename the explicit Expressive Markdown syntax from `modern` to `standard` in
  options, document ASTs and `markdownSyntax` frontmatter. No compatibility alias
  is provided; update callers and stored documents. The default is now `standard`; opt into
  `compatible` for the former CommonMark/GFM reading. Invalid runtime option
  values now fail explicitly.
- Filter authored HTML-element spellings when a document read with trusted HTML
  is written with the safe profile.

## 0.1.18

- Update Parseman to 0.55.2 and markdown-it to 15.0.3. Every corpus README and
  CommonMark and GFM example still writes back byte for byte.

## 0.1.17

- Write an unedited document back byte for byte, in both syntaxes and HTML
  profiles where the safe profile filters nothing: `parse` records the source
  text and each top-level block's range and content hash in the document's
  `source`, and `stringify` writes each unedited block from it, with the
  source's spacing between unedited neighbours and its line endings. Edited and
  new blocks are written in canonical form. All 398 corpus READMEs and every
  CommonMark and GFM example round-trip exactly with trusted HTML.
- Keep the readable text of Markdown inside an opaque inline HTML element,
  links and line breaks included, in the safe profile.
- Keep an HTML element's start tag when the sanitizer closes a void element
  such as `source`, and collapse line breaks in a class or style attribute; any
  other attribute spanning lines keeps its element as HTML.

## 0.1.16

- Add lint warnings for spellings other than the preferred form: `parse` with
  `lint: true`, or a map of rule codes, reports each with its `code`, the
  `preferred` form and the `position` of the block that holds it. See
  [lint](docs/lint.md).
- Add `preferredForms` to `stringify`, which writes the preferred form of every
  spelling the lint rules flag.
- Report `mixed-indentation` in `compatible` lists as a lint rule, and
  `br-end-tag` as a lint rule in both syntaxes.
- Add the `table-code-pipe` lint rule, which flags `\|` inside a table code span
  in `compatible`, where `modern` keeps the backslash.

## 0.1.15

- Add the `modern` syntax, the Expressive Markdown specification, beside
  `compatible`, the default, which reads CommonMark 0.31.2 and GFM. A
  `syntax` option on `parse` and `stringify` chooses, a document's
  `markdownSyntax` frontmatter overrides it, and `document.syntax` records
  it. See [syntax](docs/syntax.md).
- In `modern`, read HTML elements as `htmlElement` nodes whose content is
  Markdown, matched as HTML matches tags, in both HTML profiles; read no
  indented code, setext headings or trailing-space breaks; keep a code span's
  pipes in its table cell; read no lazy continuation; continue a list when its
  bullet or delimiter changes; read spaces in a link target that ends at its
  balancing parenthesis; nest list items and footnote continuations by relative
  indentation; split a list at a blank line between items; and use the last
  of duplicate link definitions.
- In `modern`, end an unclosed element at its first blank line, never count
  tags inside code spans or fences when finding an element's end, and keep a
  raw-text element's content raw inside a paragraph too.
- In both syntaxes, render `/>` as the complete element, close elements where
  HTML's optional end tags close them, read `/` as HTML's tokenizer does, read
  `</br>` as `<br>`, and ignore stray end tags, with diagnostics.
- Show authored HTML outside the safe profile as text, as GitHub's tag filter
  does, in place of removing it, and accept `picture` and `source`.
- Report `duplicate-definition` for a link label defined more than once.
- Keep a list table's rows in one table when blank lines separate them.
- Add `BENCH_SYNTAX` to the benchmark suite.

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
- Write classes as `.class` and IDs as `#id`, the spec's preferred spellings,
  as in `{.wide #intro}`, unless a value needs quoting. Authored `class=` and
  `id=` spellings work the same and are kept.

## 0.1.13

- Keep a link reference definition whose title spans lines; `parse` threw
  "An attribute value cannot contain a newline or NUL" (CommonMark example 196).
- Parse every README in a 398-document corpus of popular projects, and write
  each one back, in both HTML profiles.
- Advance past a mention, directive or attribute list matched while a link's
  label is scanned; markdown-it stopped with "inline rule didn't increment
  state.pos".
- Map safe HTML within its context: inline HTML blocks become paragraphs, a
  block inside inline HTML stays inline HTML, a table cell holding blocks gets
  a block body, and a lone table row stays block HTML.
- Collapse whitespace in HTML titles such as `<summary>`, keep an HTML table
  whose spans form no rectangle as HTML, and write a multiline image or link
  tooltip as native HTML.
- Write a tight list item's blocks without a blank line between a paragraph
  and a block that interrupts it, so the list stays tight.
- Keep an element's opening and closing tags as authored when CommonMark puts
  them in separate HTML blocks, such as a `<div>` or `<details>` around
  Markdown between blank lines. Rendering nests the Markdown inside, and
  `stringify` writes the tags back unchanged. Raw HTML passes CommonMark
  0.31.2's 64 HTML-block and raw-HTML examples, and GFM's apart from three
  that CommonMark 0.31 or GFM's output filter supersede.
- End a container with its enclosing block, so content after an unclosed
  container in a list item stays in place.
- Scan containers in linear time, reading each block context's code and HTML
  boundaries once. A thousand containers parse in milliseconds; the benchmark
  suite measures them as `containers`.

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
