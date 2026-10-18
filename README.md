# expressmark

Parse [Expressive Markdown](https://nextwebwg.org/expressive-markdown/) into its
JSON document AST, edit the data, and write Markdown again.

```sh
pnpm add expressmark
```

```ts
import { parse, stringify, type Document } from "expressmark";

const document: Document = parse(`::: warning [Before deploying]
Back up the database first.
:::`);

document.body[0]!.title = { type: "title", value: "Check the backup" };
console.log(stringify(document));
```

## API

`parse(markdown, options?)` synchronously returns a version-1 `Document`.
`stringify(document, options?)` synchronously returns canonical Markdown with a
terminal newline, or an empty string for an empty document. Neither function
executes code, loads assets, resolves mentions, generates a TOC, or renders HTML.

```ts
const document = parse(source, {
  onDiagnostic(diagnostic) {
    console.warn(diagnostic.code, diagnostic.message);
  },
});
const markdown = stringify(document, { onDiagnostic: console.warn });
```

Recoverable source errors produce `literal` nodes and optional warning diagnostics.
Duplicate attributes and YAML keys use the final value; duplicate authored IDs
remain unchanged. Invalid supplied ASTs, unsupported versions, unknown structural
nodes, and unsupported source mappings throw `ConversionError` with a `code`.
Unknown semantic subtypes remain valid. No conversion claims byte preservation.

The exported JSON types are `Document`, `Node`, `Attributes`, `Json`, `Position`,
`Point`, `Diagnostic`, and `ConversionOptions`. Node content uses exclusive
`body`, `children`, or `value` slots; `title` is a separate designated slot.
The writer validates these contracts at runtime, including child contexts and
merged table grids. Optional source positions are not currently generated.

## Supported writing

- CommonMark blocks and inline content, plus GFM tables, tasks, strikethrough and autolinks.
- YAML frontmatter, designated document title/ID and JSON-compatible custom metadata.
- Nested colon containers, inline/leaf directives, open semantic types and shared string/flag attributes.
- Mention shorthand with separate entity references and occurrence IDs; chips and authored TOCs.
- Adjacent `tab` grouping and explicit `tabs` settings, including shared selection names.
- Leading-pipe line blocks, code captions/presentation attributes, and rectangular merged tables.
- Safe native HTML for supported rich text, wrappers, figures, disclosures and rich table cells.

This is an implementation of a changing Stage 0 proposal, not a claim of complete
conformance. Rich native HTML is filtered by the documented
[safe HTML profile](https://github.com/nextwebwg/expressmark/blob/main/docs/safe-html.md).
Scripts and their contents are discarded during parsing and writing; literal code
containing HTML stays code. Some presentation is intentionally removed. A warning
reports filtering; a missing diagnostic callback does not disable the policy.

Rich wrappers may use the tool's inert `data-attributes` profile to retain scalar
attribute types that HTML cannot express, such as a custom false flag. It never
stores content nodes or restores executable HTML fields. Other unsupported
structures fail explicitly rather than flattening or silently dropping content.
Unrecognized safe HTML can remain opaque, with its accepted markup preserved.

The normative [syntax](https://nextwebwg.org/expressive-markdown/language),
[AST](https://nextwebwg.org/expressive-markdown/ast) and
[parser/writer rules](https://nextwebwg.org/expressive-markdown/parsing)
are maintained in `nextwebwg/specs`.

## Development and releases

Use Corepack with the committed pnpm 12 version and a supported Node LTS release:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify:pr
```

TypeScript 7 builds strict ESM declarations. Parseman recognizes extension tokens;
markdown-it handles base Markdown, YAML handles metadata, and sanitize-html with
htmlparser2 handles the safe native profile. Oxlint and Vitest verify the code,
round trips, unsafe input, malformed data, and a fresh packed-package consumer.

The manual **Release** workflow publishes reviewed `main` through the protected
`npm` environment. The version input must match `package.json`. Publication uses
npm trusted publishing with provenance. Foundation owns the shared policy files
listed in `threadlabs.config.json`.

MIT licensed. See [LICENSE](./LICENSE).
