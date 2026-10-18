# Safe documentation HTML

Expressmark filters HTML on both `parse` and `stringify`, including caller-supplied
ASTs. Literal code is excluded from HTML interpretation. The policy uses
[sanitize-html](https://github.com/apostrophecms/apostrophe/tree/main/packages/sanitize-html)
2.18.1 and htmlparser2 12.0.0; it is a tool profile, not another Markdown grammar.

## Accepted markup

The benign default tags are `address article aside footer header h1 h2 h3 h4 h5 h6
hgroup main nav section blockquote dd div dl dt figcaption figure hr li menu ol p
pre ul a abbr b bdi bdo br cite code data dfn em i kbd mark q rb rp rt rtc ruby s samp
small span strong sub sup time u var wbr caption col colgroup table tbody td tfoot
th thead tr`. The profile additionally accepts `img`, `details` and `summary`.
Unknown wrappers are removed while retaining ordinary text. Script, style,
textarea, option, iframe, object, embed, SVG, MathML and template subtrees are
removed entirely when disallowed. Comments are not retained.

| Scope | Accepted attributes |
| --- | --- |
| Every accepted tag | `id class style title lang dir data-* aria-*` |
| Link | `href name target rel` |
| Image | `src alt width height loading` |
| Disclosure | `open` |
| Ordered list / list item | `start` / `value` |
| Table cells | `colspan rowspan headers`; header cells also `scope` |

Event handlers, forms and active embedded content are not accepted. URLs use the
maintained sanitizer's URL checks, permitting relative URLs and `http`, `https`,
`mailto`, `tel`; protocol-relative and data URLs are refused. Markdown link/image
URLs receive equivalent checks when written. No assets are fetched.

Inline CSS permits only these properties and value classes:

| Properties | Accepted values |
| --- | --- |
| `color`, `background-color` | Hex/named colors or numeric RGB/HSL functions |
| `width`, `height`, `max-width` | `auto`, zero, positive decimal `px em rem % ch vh vw` lengths |
| `text-align` | `left right center justify start end` |
| `vertical-align` | `top middle bottom baseline` |
| `font-weight` | `normal bold` or 100–900 |
| `font-style` | `normal italic` |
| `text-decoration` | `none underline line-through` |
| `white-space` | `normal pre pre-wrap pre-line break-spaces` |
| `display` | `flow-root` |
| `float` | `inline-start inline-end` |
| `inline-size` | The supported size values above, or `fit-content` |
| `max-inline-size` | The supported size values above |
| `margin-inline-start`, `margin-inline-end` | `0 auto` |

Unsupported CSS is removed. This profile does not make arbitrary HTML, CSS or
application-provided renderers safe; applications must keep their output policy.

## Structured import and preservation

Common paragraphs, headings, text formatting, links, images, lists, block quotes,
code, figures, disclosures, tables and span/div groups become editable nodes.
Table spans become numeric structural fields. Other accepted elements stay
opaque `html` nodes. Native HTML descendants are HTML content, not a second
Markdown document. Markdown inline wrappers retain parsed formatting and directives.

For lossless scalar types, native wrappers can carry a `data-attributes` JSON
object alongside ordinary display attributes. Only string/boolean entries are
restored. Structural keys, IDs, references, prototype keys, event handlers,
unsafe URLs, unsupported CSS, and nested content are rejected or filtered.
The payload cannot replace a node type, body, identity or semantic reference.
The same validation applies when writing. It never saves discarded HTML for replay.

`span`/`section` with `data-type` map to inline/container semantic subtypes;
`div[data-type="layout"]` maps to a layout container and restores `data-align`
and `data-float` as ordinary layout attributes. These wrappers may include the
bounded native logical CSS used by the layout renderer. Mention `data-ref`
supplies its opaque reference. Tool-generated native tables may
carry `data-align` with their JSON column alignments. These are native import/export
profile conventions. They do not introduce new Expressive Markdown punctuation.

`html-filtered`, `html-attribute-filtered`, `invalid-html-attributes` and
`presentation-filtered` diagnostics report normalization/filtering. Sanitization
can normalize harmless spelling as well as remove rejected content, so these
warnings do not imply every normalized input was dangerous.
