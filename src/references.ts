import { normalizeLabel } from "./grammar.js";
import type { Document, Node } from "./types.js";

type Visit = (node: Node) => void;
// Walk in traversal order (a title before its content); a cyclic tree is left
// for the caller's own validation to reject.
function walk(node: Node, visit: Visit, skipNotes: boolean, active = new Set<Node>()): void {
  if (!node || typeof node !== "object" || active.has(node)) return;
  if (skipNotes && node.type === "footnoteDefinition") return;
  active.add(node);
  visit(node);
  if (typeof node.title === "object" && node.title !== null) walk(node.title, visit, skipNotes, active);
  for (const child of node.body ?? node.children ?? []) walk(child, visit, skipNotes, active);
  active.delete(node);
}

/** Visit footnote references outside definitions, in traversal order. */
export function references(node: Node, visit: (label: string) => void): void {
  walk(node, child => { if (child.type === "footnoteReference" && typeof child.label === "string") visit(child.label); }, true);
}

/** Each label's note: its first definition anywhere in the tree. */
export function footnoteDefinitions(document: Node): Map<string, Node> {
  const notes = new Map<string, Node>();
  walk(document, node => {
    if (node.type === "footnoteDefinition" && typeof node.label === "string" && !notes.has(node.label)) notes.set(node.label, node);
  }, false);
  return notes;
}

/**
 * Labels in first-reference order. Text outside notes is read first, wherever
 * definitions sit; a note that a note refers to joins the list as it is read.
 */
export function referenceOrder(document: Document, notes: ReadonlyMap<string, Node>): string[] {
  const order: string[] = [];
  const add = (label: string) => { if (notes.has(label) && !order.includes(label)) order.push(label); };
  references(document, add);
  for (let index = 0; index < order.length; index++) {
    for (const child of notes.get(order[index]!)!.body ?? []) references(child, add);
  }
  return order;
}

/** Link reference definitions by normalized label: the last wins in `modern` syntax, the first in `compatible`. */
export function linkDefinitions(document: Document | Node): Map<string, Node> {
  const last = (document as Document).syntax === "modern";
  const definitions = new Map<string, Node>();
  walk(document, node => {
    if (node.type !== "definition" || typeof node.label !== "string") return;
    const label = normalizeLabel(node.label);
    if (last || !definitions.has(label)) definitions.set(label, node);
  }, false);
  return definitions;
}
