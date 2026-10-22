# Customize HTML per node

`renderHtml(document, options?)` from `expressmark/render` renders a version-1
Expressmark document to a sanitized HTML fragment. Override one node type while
keeping the defaults everywhere else. This entry point is available from 0.1.2.

```ts
import { parse } from "expressmark";
import { renderHtml } from "expressmark/render";

const html = renderHtml(parse("::: warning [Before deploying]\nBack up first.\n:::"), {
  transformers: {
    "container:warning": (node, context) => {
      const heading = typeof node.title === "object"
        ? context.render(node.title)
        : context.escape(node.title ?? "Warning");
      return `<aside class="notice"><header>${heading}</header>${context.renderChildren()}</aside>`;
    },
  },
});
```

No parser plugin is needed: `warning` is an ordinary semantic subtype in the
existing syntax. These callbacks change HTML output, not Markdown validity.

## Select a transformer

Transformers are synchronous. The first own key found in `transformers` wins:

| Key | Matches |
| --- | --- |
| `container:warning` | Exact type and semantic subtype |
| `container` | Every node with that type |
| `*` | All remaining nodes, including the document root |

Return `undefined` to use the current node's built-in mapping. Lookup does not
continue through lower-priority keys. Return `""` to omit the node and its subtree.
Exceptions propagate. Unknown node types require a transformer or throw
`ConversionError` with code `unsupported-html-node`.

## Extend the default output

```ts
const html = renderHtml(parse("# Hello *world*"), {
  transformers: {
    heading: (_node, context) =>
      `<section class="hero">${context.renderDefault()}</section>`,
    emphasis: (_node, context) => `<mark>${context.renderChildren()}</mark>`,
  },
});
// <section class="hero"><h1>Hello <mark>world</mark></h1></section>
```

| Context method | Behavior |
| --- | --- |
| `escape(text)` | Escape `&`, `<`, `>`, and `"` for text or quoted attribute values |
| `renderChildren()` | Render escaped `value`, or `body`/`children` through overrides; excludes `title` and footnote definitions, which render in the document's notes section |
| `renderDefault()` | Render the current node with its built-in mapping, keeping child overrides |
| `render(node)` | Render another node, including a designated title, through overrides |

`renderDefault()` applies the code/opaque HTML rules for those node types.
`renderChildren()` treats `value` as text. Calling `render()` on an active ancestor
throws `ConversionError` with code `cyclic-html-node`.

## Page rendering options

```ts
renderHtml(document, {
  headingIds: true,        // recommended anchors on headings without an authored ID
  title: false,            // leave out the designated title's <h1>; document.title remains
  escapeText: html => html.replace(/\{/g, "&#123;"), // every text run and code value
});
```

`headingIds` uses `headingAnchors(document)`, exported from `expressmark`,
which returns each heading's ID by the specification's
[recommended anchor algorithm](https://nextwebwg.org/expressive-markdown/parsing#recommended-output-anchors):
IDs authored in the body are reserved first, other headings take their text's
anchor, and collisions add `-1`, `-2` and so on. The document's own `id` is its
identity, written on no element, so it reserves no anchor. Call it to build outlines and cross-page
links that match the rendered IDs. `anchorText(text)` gives one text's anchor.

`escapeText` runs after the safe profile on every rendered text run and code
value, such as escaping `{` for a template host. It receives HTML-escaped text
and returns HTML. Raw HTML, attribute values and transformer markup never pass
through it; text a transformer renders through `context.render` or
`renderChildren` does. Trusted host HTML is described in the
[safe HTML profile](safe-html.md#trusted-host-content).

## Defaults and output policy

Common Markdown maps to native paragraphs, headings, formatting, lists, quotes,
links, images and code. Tables retain captions and cell spans. `details` and
`figure` containers use native elements. Layout containers use `div[data-type="layout"]`
with logical alignment and floating. Other containers use `section[data-type]`;
inline directives use `span[data-type]`. A document title renders as an initial
`h1`; metadata is not rendered. Text with an identity or attributes uses a `span`;
custom scalar attributes use inert `data-*` names.

Task status uses inert `☑`/`☐` markers because form controls are outside the shared
safe HTML profile. TOC leaves produce an empty `nav[data-type="toc"]` placeholder.
Tabs remain semantic containers. Table column alignment and application-specific
presentation need a transformer. Rendering does not fetch assets, execute code,
resolve mentions, generate navigation or attach interaction.

## Layout

The [public layout contract](https://nextwebwg.org/expressive-markdown/language#layout)
defines `align=start|center|end` and optional `float=start|end` on ordinary
`container` nodes with `subType: "layout"`. The parser needs no plugin.

```md
::: layout {align=center & float=end & style="inline-size:12rem"}
> A small example is easier to understand.

— The editor
:::

This paragraph can flow beside the whole quotation and attribution.
```

Alignment positions the group's child blocks and supplies their text alignment.
A nested layout can override alignment; otherwise it inherits the enclosing
layout's value, defaulting to `start`. Safe explicit child text styles take
precedence. Floating applies to the whole group, independently of its internal
alignment, and is not inherited. Source and reading order stay intact.

Set `dir=rtl` on a layout or inherit direction from its host HTML; `lang=ar` or
`lang=he` labels content but does not set direction. Logical start/end resolve
against the containing flow for floating, the parent layout for block placement,
and the text's own direction for text alignment. This also permits LTR text
inside an RTL layout. No physical left/right layout aliases are defined.

The implementation composes native `flow-root`, logical inline sizes/margins,
`text-align` and `float:inline-start|inline-end`. Item wrappers keep placement in
the parent's direction when a child has its own `dir`. Floated child layouts
share their siblings' flow rather than receiving an isolating item wrapper.
Images inside layouts have a default `max-inline-size:100%`. An authored safe
style can override the renderer's defaults. Custom layout transformers own their
replacement presentation and still pass through the shared sanitizer.

Native floating needs room beside the group. At narrow widths text can continue
below it; a layout in a host flex/grid context follows native float behavior.
The renderer adds no positioning runtime or external stylesheet.

Unsupported align/float values remain authored data and emit
`unsupported-layout-attribute` during default rendering. They use the omitted
attribute behavior. Native `div[data-type="layout"]` wrappers import as editable
layout containers, with `data-align`/`data-float` restored to their attributes.

Run `corepack pnpm exec playwright install chromium firefox webkit` once, then
`corepack pnpm test:browser`. The single-worker suite measures rendered block and
text geometry after parsing, rendering and sanitizing in Chromium, Firefox and
WebKit. It covers start/center/end and both floats in English, Arabic and Hebrew,
plus a narrow RTL viewport, inherited alignment and a nested LTR override.
`verify:pr` includes these browser tests.

## Input and filtering

The renderer does not mutate the AST. Callbacks receive a shallow readonly node
and remain responsible for their own mutations. Input must be parser output or a
well-formed AST. Document version and traversal cycles are checked; this function
does not run the Markdown writer's full structural validation.

The assembled output, **including custom transformer output**, passes once
through the existing [safe HTML profile](./safe-html.md). Scripts, event handlers,
unsafe URLs, unsupported tags and CSS are filtered. `onDiagnostic` reports
normalization/filtering. There is no bypass option. Escape authored strings in
HTML templates; sanitization does not replace text escaping. Custom elements,
forms, SVG and arbitrary CSS are outside the profile.

The public rendering types are `HtmlRenderOptions`, `HtmlTransformer` and
`HtmlRenderContext`, exported from `expressmark/render`. markdown-it remains an
internal dependency with no supported plugin/configuration hook.
