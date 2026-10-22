import { plainText } from "./grammar.js";
import type { Node } from "./types.js";

/** The specification's readable anchor for a heading or title text. */
export function anchorText(text: string): string {
  const id = text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, "-").replace(/^-+|-+$/g, "");
  return id || "section";
}

function walk(node: Node, visit: (node: Node) => void, active = new Set<Node>()): void {
  if (!node || typeof node !== "object" || active.has(node)) return;
  active.add(node);
  visit(node);
  if (typeof node.title === "object" && node.title !== null) walk(node.title, visit, active);
  for (const child of node.body ?? node.children ?? []) walk(child, visit, active);
  active.delete(node);
}

/**
 * Each heading's output ID by the specification's recommended anchor
 * algorithm: authored IDs are reserved first and kept; other headings take
 * their text's anchor, with `-1`, `-2` and so on after a collision. The AST is
 * not changed.
 */
export function headingAnchors(document: Node): Map<Node, string> {
  const used = new Set<string>();
  walk(document, node => { if (typeof node.id === "string") used.add(node.id); });
  const anchors = new Map<Node, string>();
  walk(document, node => {
    if (node.type !== "heading") return;
    if (typeof node.id === "string") { anchors.set(node, node.id); return; }
    const base = anchorText(plainText(node));
    let candidate = base;
    for (let suffix = 1; used.has(candidate); suffix++) candidate = `${base}-${suffix}`;
    used.add(candidate);
    anchors.set(node, candidate);
  });
  return anchors;
}
