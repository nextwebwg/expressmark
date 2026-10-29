# Lint: preferred forms

Expressive Markdown accepts several spellings for some constructs and names one
of them preferred. `parse` reports each other spelling as a lint warning when
you ask, and `stringify` can write the preferred form of each one.

```ts
const document = parse(source, {
  lint: true,
  onDiagnostic(diagnostic) {
    // { code: "prefer-dash-bullet", severity: "warning", preferred: "-",
    //   position: { start: { line: 3, column: 1 }, end: { line: 5, column: 4 } } }
  },
});
const tidy = stringify(document, { preferredForms: true });
```

`lint: true` turns every rule on. A map turns rules on except those set to
`false`, such as `{ "prefer-dash-bullet": false }`. Each warning has its `code`,
the `preferred` form and a `position`: the source lines of the block that holds
the spelling. Columns start at the block's first column.

Without `preferredForms`, `stringify` writes each authored spelling back.

## Rules

| Code | Flags | Preferred |
| --- | --- | --- |
| `prefer-colon-callout` | An alert, `> [!note]` | `::: note` |
| `prefer-bracketed-title` | An unbracketed container title | `::: type [Title]` |
| `prefer-canonical-header` | A container or leaf header's spacing, part order or case | `type [Title] {attributes}` |
| `prefer-container-fence` | A container fence longer than its nesting needs | three colons, plus one per nesting level |
| `prefer-adjacent-tabs` | An explicit `::: tabs` wrapper | adjacent `::: tab` containers |
| `prefer-fenced-code` | Indented code, in `compatible` | a backtick fence |
| `prefer-shortest-fence` | A tilde fence, or a longer one than the code needs | the shortest backtick fence |
| `prefer-canonical-info` | A code fence's info in another order or spelling | `language {attributes} meta` |
| `prefer-shortest-code-span` | A code span with a longer backtick run than it needs | the shortest run |
| `prefer-atx-heading` | A setext heading, in `compatible` | `# Heading` |
| `prefer-open-atx-heading` | Closing hashes on a heading | `# Heading` |
| `prefer-backslash-break` | A trailing-space hard break, in `compatible` | a trailing `\` |
| `prefer-star-emphasis` | `_` emphasis or `__` strong | `*` and `**` |
| `prefer-dash-bullet` | `*` or `+` bullets | `-` |
| `prefer-dot-delimiter` | `1)` | `1.` |
| `prefer-incrementing-numbers` | Repeated item numbers | `1.` `2.` `3.` |
| `prefer-list-bullet` | An item whose bullet or delimiter differs from its list's, in `standard` | the list's own |
| `prefer-lowercase-task` | `[X]` | `[x]` |
| `prefer-dash-break` | `***`, `___` or a spaced or longer break | `---` |
| `prefer-link-syntax` | `<url>` or a bare URL | `[text](url)` |
| `prefer-canonical-target` | A link or image target in another spelling | `(destination "title")` |
| `prefer-canonical-definition` | A link definition in another spelling | `[label]: destination "title"` |
| `prefer-named-table` | A pipe table or positional list rows | a `::: table` with named fields |
| `prefer-bracketed-mention` | A bare `@handle` | `@[label]` |
| `prefer-canonical-line-block` | Line-block marker spacing or continuation lines | `\| ` lines |
| `prefer-canonical-definition-list` | Definition-list marker spacing or indentation, continuation indentation, or blank lines between terms | a term line, `: ` descriptions with two-space continuation, one blank line before each later term |
| `mixed-indentation` | A list mixing tabs and spaces, in `compatible` (always reported in `standard`, and for a description in both) | one kind of indentation |
| `br-end-tag` | `</br>`, read as `<br>` | `<br>` |
| `table-code-pipe` | `\|` inside a table cell's code span, in `compatible`; `standard` keeps the backslash | `\|` written as `|` inside the code span |

Longhand attributes, `{class="…" id="…"}`, work the same as `{.class #id}` and
have no rule, and a typeless container such as `::: {.render}` is a preferred
form. A list right after another list keeps the bullet that separates them, so
it has no warning. Conversion-only spellings, such as `:mention` and
`== Label`, are not accepted spellings and have no rule.

## Accepted readings in `standard`

Two readings change on purpose when a document moves to `standard`, as
[syntax](syntax.md#moving-a-document-to-standard) describes: `\|` inside a table
code span shows its backslash, which `table-code-pipe` flags, and
`[url](some words)` is a link to `some%20words`.

## Follow-up: migrating to `standard`

A rule that flags, in a `compatible` document, each construct that renders
differently under [`standard`](syntax.md) is a follow-up. Today, the rules above
already flag indented code, setext headings and trailing-space breaks.
