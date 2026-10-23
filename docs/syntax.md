# Syntax: `modern` and `compatible`

Expressmark reads Markdown in one of two syntaxes:

- **`modern`** is the [Expressive Markdown specification](https://nextwebwg.org/expressive-markdown/).
- **`compatible`** is the default. It is CommonMark 0.31.2 and GFM, plus the
  Expressive Markdown extensions, so existing Markdown renders as it does
  elsewhere.

## Choosing the syntax

A document chooses with a frontmatter key, and a host chooses the default for
documents that set none:

```md
---
syntax: modern
---
```

```ts
parse(source, { syntax: "modern" });        // the default for this document
stringify(document, { syntax: "modern" });  // the host's default, for writing
```

Frontmatter wins over the option. The key's values are `modern` and
`compatible`; any other value stays ordinary metadata and reports
`invalid-syntax`. A site generator such as Markupress passes its site-wide
default as the option.

The document records the syntax that read it as `document.syntax`, which is
`"modern"` for a `modern` document and the authored value when frontmatter sets
the key. A document without it is `compatible`. `stringify` writes the
`syntax` key when the document's syntax differs from the host default it is
given, and keeps authored frontmatter as written.

## Where `compatible` follows CommonMark and GFM

`compatible` reads these constructs as CommonMark 0.31.2 and GFM read them. The
Expressive Markdown specification states the `modern` reading of each one,
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
<!-- modern -->
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
rules above. `modern` reads elements into `htmlElement` nodes, whose content is
Markdown.

## Expressive Markdown extensions in `compatible` documents

Containers, leaf and inline directives, bracketed spans, alerts, footnotes, line
blocks, list tables and attribute lists have the same syntax in both. Their
content is Markdown read with the document's syntax, so inside a `compatible`
container indented code, setext headings and lazy continuation behave as
CommonMark's do, with indentation counted from the fence's edge. An alert is a
block quote, so it continues lazily in `compatible` and needs `>` on every line
in `modern`.

## Diagnostics

| Code | Syntax | Meaning |
| --- | --- | --- |
| `invalid-syntax` | both | The frontmatter `syntax` value is not `modern` or `compatible`. |
| `duplicate-definition` | both | A link reference label is defined more than once. `modern` uses the last definition, `compatible` the first. |
| `mixed-indentation` | `modern` | A list's indentation mixes tabs and spaces so that neither line's indentation starts with the other's; tabs count to the next multiple of four columns. |
| `unclosed-html-element` | `modern` | An element has no closing tag; it ends with its enclosing block. |
| `stray-end-tag` | both | An end tag closes no open element and is ignored. |
| `br-end-tag` | both | `</br>` is read as `<br>`; write `<br>`. |
| `html-element-escaped` | both | An element outside the safe HTML profile is shown as text. |
