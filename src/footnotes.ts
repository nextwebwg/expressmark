import type { Document, Node } from "./types.js";

/** Visit footnote references in traversal order: a title before its content. */
export function references(node: Node, visit: (label: string) => void, active = new Set<Node>()): void {
  // A cyclic tree is left for the caller's own validation to reject.
  if (!node || typeof node !== "object" || active.has(node)) return;
  active.add(node);
  if (node.type === "footnoteReference" && typeof node.label === "string") visit(node.label);
  if (typeof node.title === "object" && node.title !== null) references(node.title, visit, active);
  for (const child of node.body ?? node.children ?? []) references(child, visit, active);
  active.delete(node);
}

/**
 * Labels in first-reference order. The body is read first; a note that a note
 * refers to joins the list as that note is read, so numbering stays one pass.
 */
export function referenceOrder(document: Document, notes: ReadonlyMap<string, Node>): string[] {
  const order: string[] = [];
  const add = (label: string) => { if (notes.has(label) && !order.includes(label)) order.push(label); };
  if (document.title) references(document.title, add);
  for (const child of document.body) references(child, add);
  for (let index = 0; index < order.length; index++) references(notes.get(order[index]!)!, add);
  return order;
}
