# expressmark

JavaScript tooling for [Expressive Markdown](https://nextwebwg.org/expressive-markdown/),
a common language for documentation.

**The 0.0.x releases establish the package and its independent repository. They export
no API. Parsing, writing, rendering and AST utilities are not implemented yet.**

The language and official AST are defined in the
[public proposal](https://nextwebwg.org/expressive-markdown/ast), maintained in
[nextwebwg/specs](https://github.com/nextwebwg/specs/tree/main/expressive-markdown).
Normative specification material lives there.

## Development

Use Corepack with the committed pnpm 12 version and a supported Node LTS release:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify:pr
```

The project uses TypeScript 7, Oxlint and Vitest. Parseman is pinned as a development
dependency for the upcoming Markdown ↔ AST converter; the scaffold has no runtime
dependencies. `pnpm verify:pr` checks lint, strict types, the build, and consumption of
the packed package from a fresh installation. No browser runner is needed for this scaffold.

Foundation owns the shared policy files listed in `threadlabs.config.json`. The package,
its API, documentation and workflows are locally owned. Dependabot proposes dependency
updates; the weekly freshness workflow reports outdated pins for review.

## Releases

Version 0.0.1 reserved the npm name from the HTML Next monorepo. Version 0.0.2 moves the
package here and updates its repository metadata. Versions are independent of HTML Next.

The manual **Release** workflow publishes only a reviewed `main` commit through the
`npm` environment, which requires owner approval. Its version input must match
`package.json`; lint, types, packed-consumer checks and a clean source tree are required.
Publication uses npm trusted publishing with provenance, without a repository npm token.
The npm trusted publisher must name `nextwebwg/expressmark`, `release.yml`, environment `npm`.

MIT licensed. See [LICENSE](./LICENSE).
