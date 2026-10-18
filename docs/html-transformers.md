# Customize HTML per node

`renderHtml(document, options?)` from `expressmark/render` renders a version-1
Expressmark document to a sanitized HTML fragment. Override one node type while
keeping the defaults everywhere else. This entry point is new for 0.1.2 and is not
available in the published 0.1.1 package.

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
| `renderChildren()` | Render escaped `value`, or `body`/`children` through overrides; excludes `title` |
| `renderDefault()` | Render the current node with its built-in mapping, keeping child overrides |
| `render(node)` | Render another node, including a designated title, through overrides |

`renderDefault()` applies the code/opaque HTML rules for those node types.
`renderChildren()` treats `value` as text. Calling `render()` on an active ancestor
throws `ConversionError` with code `cyclic-html-node`.

## Defaults and output policy

Common Markdown maps to native paragraphs, headings, formatting, lists, quotes,
links, images and code. Tables retain captions and cell spans. `details` and
`figure` containers use native elements. Other containers use `section[data-type]`;
inline directives use `span[data-type]`. A document title renders as an initial
`h1`; metadata is not rendered. Text with an identity or attributes uses a `span`;
custom scalar attributes use inert `data-*` names.

Task status uses inert `☑`/`☐` markers because form controls are outside the shared
safe HTML profile. TOC leaves produce an empty `nav[data-type="toc"]` placeholder.
Tabs remain semantic containers. Table column alignment and application-specific
presentation need a transformer. Rendering does not fetch assets, execute code,
resolve mentions, generate navigation or attach interaction.

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
