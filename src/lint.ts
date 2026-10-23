import { linting, type ConversionOptions, type Document, type Node, type Position } from "./types.js";

/**
 * Non-preferred spellings, read from what `parse` records. Each rule names the
 * construct's preferred form and removes the record, so `stringify` writes it.
 */
interface Rule { code: string; type: string | string[]; holds: (node: Node, previous?: Node) => boolean; preferred: string; fix: (node: Node) => void }
// A list right after another list keeps its own bullet or delimiter, which separates them.
const separates = (node: Node, previous?: Node) => previous?.type === "list" && previous.ordered === node.ordered;
const drop = (...keys: string[]) => (node: Node) => {
  if (!node.source) return;
  for (const key of keys) delete node.source[key];
  if (!Object.keys(node.source).length) delete node.source;
};
const has = (key: string, value?: unknown) => (node: Node) => node.source?.[key] !== undefined && (value === undefined || node.source[key] === value);
export const lintRules: readonly Rule[] = [
  { code: "prefer-colon-callout", type: "container", holds: node => node.spelling === "alert", preferred: "::: type", fix: node => { delete node.spelling; drop("type")(node); } },
  { code: "prefer-bracketed-title", type: "container", holds: node => node.titleSpelling === "unbracketed", preferred: "::: type [Title]", fix: node => { delete node.titleSpelling; } },
  { code: "prefer-canonical-header", type: ["container", "leaf"], holds: has("header"), preferred: "type [Title] {attributes}", fix: drop("header") },
  { code: "prefer-container-fence", type: ["container", "table"], holds: has("fence"), preferred: "three colons, plus one per nesting level", fix: drop("fence") },
  { code: "prefer-adjacent-tabs", type: "container", holds: has("form", "explicit"), preferred: "adjacent ::: tab containers", fix: drop("form") },
  { code: "prefer-fenced-code", type: "code", holds: has("form", "indented"), preferred: "```", fix: drop("form") },
  { code: "prefer-shortest-fence", type: "code", holds: has("fence"), preferred: "the shortest backtick fence", fix: drop("fence") },
  { code: "prefer-canonical-info", type: "code", holds: has("info"), preferred: "language {attributes} meta", fix: drop("info") },
  { code: "prefer-shortest-code-span", type: "inlineCode", holds: has("fence"), preferred: "the shortest backtick run", fix: drop("fence") },
  { code: "prefer-atx-heading", type: "heading", holds: has("form", "setext"), preferred: "# Heading", fix: drop("form", "underline") },
  { code: "prefer-open-atx-heading", type: "heading", holds: has("closing"), preferred: "# Heading, without closing hashes", fix: drop("closing") },
  { code: "prefer-backslash-break", type: "break", holds: has("spaces"), preferred: "a trailing \\", fix: drop("spaces") },
  { code: "prefer-star-emphasis", type: ["emphasis", "strong"], holds: has("marker", "_"), preferred: "* and **", fix: drop("marker") },
  { code: "prefer-dash-bullet", type: "list", holds: (node, previous) => !node.ordered && has("marker")(node) && !separates(node, previous), preferred: "-", fix: drop("marker") },
  { code: "prefer-dot-delimiter", type: "list", holds: (node, previous) => node.ordered === true && has("marker", ")")(node) && !separates(node, previous), preferred: "1.", fix: drop("marker") },
  { code: "prefer-incrementing-numbers", type: "list", holds: has("numbering", "same"), preferred: "1. 2. 3.", fix: drop("numbering") },
  { code: "prefer-list-bullet", type: "listItem", holds: has("bullet"), preferred: "the list's own bullet or delimiter", fix: drop("bullet") },
  { code: "prefer-lowercase-task", type: "listItem", holds: has("marker", "X"), preferred: "[x]", fix: drop("marker") },
  { code: "prefer-dash-break", type: "horizontalRule", holds: has("marker"), preferred: "---", fix: drop("marker") },
  { code: "prefer-link-syntax", type: "link", holds: node => has("form", "angle")(node) || has("form", "bare")(node), preferred: "[text](url)", fix: drop("form") },
  { code: "prefer-canonical-target", type: ["link", "image"], holds: has("target"), preferred: "(destination \"title\")", fix: drop("target") },
  { code: "prefer-canonical-definition", type: "definition", holds: has("markdown"), preferred: "[label]: destination \"title\"", fix: drop("markdown") },
  { code: "prefer-named-table", type: "table", holds: node => has("form", "pipe")(node) || has("form", "positional")(node), preferred: "::: table with named fields", fix: drop("form", "markdown") },
  { code: "prefer-bracketed-mention", type: "inline", holds: node => node.subType === "mention" && has("form", "bare")(node), preferred: "@[label]", fix: drop("form") },
  { code: "prefer-canonical-line-block", type: "lineBlock", holds: has("markdown"), preferred: "| lines", fix: drop("markdown") },
];
/** Lint codes, each a rule `options.lint` can turn off by name. */
export type LintCode = (typeof lintRules)[number]["code"];

function walk(node: Node, visit: (node: Node, position: Position | undefined, previous?: Node) => void, positions: WeakMap<Node, Position>, position?: Position, previous?: Node): void {
  const own = positions.get(node) ?? position;
  visit(node, own, previous);
  if (typeof node.title === "object" && node.title) walk(node.title, visit, positions, own);
  const children = node.body ?? node.children ?? [];
  children.forEach((child, index) => walk(child, visit, positions, own, children[index - 1]));
}
const applies = (rule: Rule, node: Node, previous?: Node) => (Array.isArray(rule.type) ? rule.type.includes(node.type) : rule.type === node.type) && rule.holds(node, previous);
/** Report each non-preferred spelling, at the lines of the block that holds it. */
export function lint(document: Document, positions: WeakMap<Node, Position>, options: ConversionOptions): void {
  walk(document, (node, position, previous) => {
    for (const rule of lintRules) if (linting(options.lint, rule.code) && applies(rule, node, previous)) {
      options.onDiagnostic?.({ code: rule.code, message: `Prefer ${rule.preferred}.`, severity: "warning", preferred: rule.preferred, ...(position ? { position } : {}) });
    }
  }, positions);
}
/** Write the preferred form of every spelling the lint rules flag. */
export function preferForms(document: Node): void {
  walk(document, (node, _position, previous) => { for (const rule of lintRules) if (applies(rule, node, previous)) rule.fix(node); }, new WeakMap());
}
