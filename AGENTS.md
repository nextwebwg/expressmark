# Expressmark repository contract

- This public MIT repository holds JavaScript tooling for Expressive Markdown. The
  normative language and official AST live in `nextwebwg/specs`, published at
  https://nextwebwg.org/expressive-markdown/. Keep specification prose and conformance
  decisions there; implementation notes belong here.
- The 0.1.x converters cover the documented draft subset; the separate HTML
  renderer uses the documented safe profile. Do not claim full conformance.
  Unsupported AST conversions fail explicitly.
- Use parseman for the Markdown ↔ AST converter, strict ESM TypeScript 7, pnpm 12
  through Corepack, Oxlint and Vitest. Keep exact reviewed pins in the package and lockfile.
- Treat `threadlabs.config.json` as the ownership map. Review Foundation plans and their
  digest before applying them; preserve locally owned files. `AGENTS.md` is canonical,
  and `CLAUDE.md` routes here.
- Never add Prettier or Tailwind. Preserve unrelated changes; do not rewrite shared
  history or force-push without explicit owner authorization.
- Run `pnpm verify:pr` before delivery. Keep tests within two workers and choose
  meaningful parser/round-trip/consumer contracts rather than tests that restate code.
- Follow `docs/code-documentation-standard.md`: explain invariants and non-obvious
  decisions beside their implementation; avoid blanket JSDoc or comment quotas.
- Publication uses the owner-approved `npm` environment and the manual release
  workflow on `main`. Never publish from a dirty source tree or a feature branch.
- Keep private consumer context and motivating project names out of public examples,
  templates, fixtures and documentation.

## Future exploration

- Keep the Markdown reader (`src/markdown`) internal; do not expose parser plugins
  without an explicit task revisiting that decision. Prefer standard semantic types
  and node rendering.
- Read [the exploration backlog](docs/future-exploration.md) before investigating
  Parseman replacement, parser speed claims, or a future extension system. Its
  research questions are not approved migrations or language requirements.
