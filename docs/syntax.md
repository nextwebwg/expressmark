# Syntax: `standard` and `compatible`

Since 0.2.0, `standard` replaces the former `modern` name without an alias.
Update option values, stored AST `syntax` values and `markdownSyntax` frontmatter.
Invalid runtime options throw; unknown frontmatter values remain metadata and
report `invalid-syntax`. The default is now `standard`.

Expressmark reads Markdown in one of two syntaxes:

- **`standard`**, the default, follows the [Expressive Markdown specification](https://nextwebwg.org/expressive-markdown/).
- **`compatible`** is an explicit opt-in to CommonMark 0.31.2 and GFM, plus the
  Expressive Markdown extensions, so existing Markdown renders as it does
  elsewhere.

## Choosing the syntax

Set the syntax in configuration: the options object you pass to `parse` and
`stringify`, or a site generator's config, such as Markupress's
`markdownSyntax`.

```ts
const options = { syntax: "standard" } as const;
const document = parse(source, options);
const markdown = stringify(document, options);
```

A document can choose for itself with the frontmatter key `markdownSyntax`,
which overrides the configuration for that document:

```md
---
markdownSyntax: compatible
---
```

The key's values are `standard` and `compatible`; any other value stays ordinary
metadata and reports `invalid-syntax`. Inside expressmark's API the option is
named `syntax`, and the document records the syntax that read it as
`document.syntax` when it is `compatible` or frontmatter sets it. An absent
value means `standard`, including on manually built documents.
`stringify` writes `markdownSyntax` when the document's syntax differs from the
`syntax` option it is given, and keeps authored frontmatter as written.

## Where `compatible` follows CommonMark and GFM

`compatible` reads these constructs as CommonMark 0.31.2 and GFM read them. The
Expressive Markdown specification states the `standard` reading of each one,
with an example of both.

| Construct | `compatible` |
| --- | --- |
| HTML blocks | CommonMark's seven HTML-block start conditions decide where raw HTML begins and ends, and the HTML inside stays raw text. |
| Indented code | Four columns of indentation make indented code. |
| Fence indentation | Inside a `:::` container, indentation counts from the fence's edge, as inside a code fence: each enclosed line loses up to as many leading spaces as the fence has, and a line indented four columns beyond the fence is indented code. |
| Setext headings | A paragraph underlined with `===` or `---` is a level-1 or level-2 heading. |
| Hard breaks | Two or more trailing spaces make a hard break, as do a trailing `\` and `<br>`. |
| Code spans in table cells | A `\|` splits the cell, inside a code span too; `\|` keeps a pipe. |
| Lazy continuation | A paragraph continues onto a line without its quote marker or list indentation. |
| List markers | Changing the bullet character, or `.` to `)`, starts a new list. |
| Link targets | A target holding spaces needs angle brackets, `[a](<my file.md>)`. |
| List nesting | A line belongs to a list item when it is indented to the item's content column. |
| Blank lines in lists | A blank line between items makes the whole list loose, giving every item `<p>`. |
| Duplicate link definitions | The first definition of a label wins. |

```md
Title
---
```

```html
<!-- compatible -->
<h2>Title</h2>
<!-- standard -->
<p>Title</p><hr>
```

## HTML elements in both syntaxes

Both syntaxes read HTML elements the same way, as the specification states:

- `/>` closes every element, and the output writes the complete element:
  `<x-embed video="1" />` renders as `<x-embed video="1"></x-embed>`.
  `stringify` writes the authored `/>` back.
- Void elements take no closing tag; `<img>` and `<img />` are the same.
- HTML's optional end tags close an element where HTML closes it:
  `<ul><li>a<li>b</ul>` holds two items.
- `/` makes a tag self-closing only as HTML's tokenizer reads it, so
  `<a href=/docs/>` is an ordinary start tag whose `href` is `/docs/`.
- A stray end tag, one that closes no open element, is ignored and reports
  `stray-end-tag`. `</br>` is a `<br>` and reports `br-end-tag`.

`compatible` still finds raw HTML with CommonMark's conditions, and keeps it as
`html` nodes that `stringify` writes back byte for byte. Rendering applies the
rules above. `standard` reads elements into `htmlElement` nodes, whose content is
Markdown.

## Expressive Markdown extensions in `compatible` documents

Containers, leaf and inline directives, bracketed spans, alerts, footnotes, line
blocks, definition lists, list tables and attribute lists have the same syntax
in both. Their content is Markdown read with the document's syntax, so inside a
`compatible` container indented code, setext headings and lazy continuation
behave as CommonMark's do, with indentation counted from the fence's edge. An
alert is a block quote, so it continues lazily in `compatible` and needs `>` on
every line in `standard`. A definition list's description has no lazy
continuation in either syntax: an unindented line ends it. In `compatible`, a
list item or quote paragraph still continues lazily onto a `: ` line, which then
reads as paragraph text.

## Moving a document to `standard`

Most documents read the same way in both syntaxes. These readings change as
the specification intends, and are worth checking when a document moves:

- **`\|` inside a table code span.** GFM authors write `` `a \| b` `` so the pipe
  stays in its cell. In `standard` a code span is literal, so the backslash shows;
  write `` `a | b` ``. The `table-code-pipe` [lint rule](lint.md) flags it in
  `compatible` documents.
- **A parenthesized phrase after brackets.** `[url](some words)` is a link to
  `some%20words` in `standard`, since a link target may hold spaces; write
  `[url]\(some words)` to keep the text.
- **Indented code, setext headings and trailing-space breaks** read as text, a
  thematic break and a soft break. The lint rules `prefer-fenced-code`,
  `prefer-atx-heading` and `prefer-backslash-break` flag them.
- **Loose lists** split at their blank lines, and **lazy continuation lines**
  end their quote or list.

## Diagnostics

| Code | Syntax | Meaning |
| --- | --- | --- |
| `invalid-syntax` | both | The frontmatter `markdownSyntax` value is not `standard` or `compatible`. |
| `duplicate-definition` | both | A link reference label is defined more than once. `standard` uses the last definition, `compatible` the first. |
| `mixed-indentation` | both | A list's or a description's indentation mixes tabs and spaces so that neither line's indentation starts with the other's; tabs count to the next multiple of four columns. Always reported in `standard`, and for a list as a [lint rule](lint.md) in `compatible`. |
| `unattached-definition-marker` | both | A line starting with `:` or `~` and a space, a tab or the line end reads as paragraph text: a later line of a paragraph, or a paragraph after a one-line paragraph and a blank line. |
| `unclosed-html-element` | `standard` | An element has no closing tag; it ends at its first blank line, or with its paragraph. |
| `stray-end-tag` | both | An end tag closes no open element and is ignored. |
| `br-end-tag` | both | `</br>` is read as `<br>`; write `<br>`. A [lint rule](lint.md). |
| `html-element-escaped` | both | An element outside the safe HTML profile is shown as text. |
