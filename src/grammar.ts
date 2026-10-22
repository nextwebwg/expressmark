import { parse as run, regex } from "parseman";
import type { Attributes, ConversionOptions, Node } from "./types.js";
import { ConversionError, warn } from "./types.js";

const identifier = regex(/[A-Za-z][A-Za-z0-9_-]*/);
const handle = regex(/[\p{L}\p{N}_][\p{L}\p{M}\p{N}_-]*/u);
const entry = regex(/(?:#[^\s&{}]+|!?[A-Za-z][A-Za-z0-9_-]*(?:=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s&{}"']+))?)/);
// `> [!type] Title` opens an alert: the marker is followed by a space, tab or line end.
export const alertMarker=/^\[!([A-Za-z][A-Za-z0-9_-]*)\](?:[ \t]+([^\n]*))?[ \t]*(?:\n|$)/;
// Recognized structural types keep the colon form; an alert names a callout.
export const structuralTypes=new Set(["details","figure","layout","tabs","tab","toc","table"]);
export function tokenIdentifier(source: string): string | undefined {
  const result = run(identifier, source);
  return result.ok ? result.value : undefined;
}
export function tokenHandle(source: string): string | undefined {
  const result = run(handle, source);
  return result.ok ? result.value : undefined;
}
export function mentionBoundary(source: string, offset: number): boolean {
  return offset === 0 || /\s/u.test(source[offset-1]!);
}
export function attributeKey(key: string): string {
  return key.toLowerCase().split("-").filter(Boolean).map((part, i) => i ? part.replace(/^[a-z]/, c => c.toUpperCase()) : part).join("");
}
export function sourceKey(key: string): string { return key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`); }
export interface AttributeResult { length: number; id?: string; attributes: Attributes }
export function readAttributes(source: string, options: ConversionOptions = {}): AttributeResult | undefined {
  if (source[0] !== "{" || /[ \t]/.test(source[1] ?? "")) return;
  let cursor = 1;
  const result: AttributeResult = { length: 0, attributes: {} };
  const seen = new Set<string>();
  while (cursor < source.length && source[cursor] !== "}") {
    const parsed = run(entry, source.slice(cursor));
    if (!parsed.ok) return;
    const raw = parsed.value;
    if(/[\r\n]/.test(raw)) return;
    const equal = raw.indexOf("=");
    let key: string;
    let value: string | boolean;
    if (raw.startsWith("#")) { key = "id"; value = raw.slice(1); }
    else if (equal >= 0) {
      key = attributeKey(raw.slice(0, equal));
      const assigned = raw.slice(equal + 1);
      value = /^["']/.test(assigned) ? assigned.slice(1, -1).replace(new RegExp(`\\\\([\\\\${assigned[0]}])`, "g"), "$1") : assigned;
    } else { key = attributeKey(raw.replace(/^!/, "")); value = !raw.startsWith("!"); }
    if (seen.has(key)) warn(options, "duplicate-attribute", `Repeated attribute ${key}; the last value wins.`);
    seen.add(key);
    if (key === "id") {
      if (typeof value !== "string") return;
      result.id = value;
    } else result.attributes[key] = value;
    cursor += parsed.span.end;
    if (source[cursor] === "}") break;
    const separator = /^[ \t&]+/.exec(source.slice(cursor));
    if (!separator) return;
    cursor += separator[0].length;
    if (source[cursor] === "}") return;
  }
  if (source[cursor] !== "}" || /[ \t]/.test(source[cursor - 1] ?? "")) return;
  result.length = cursor + 1;
  return result;
}
export function attach(node: Node, result: AttributeResult): void {
  if (result.id !== undefined) node.id = result.id;
  if (Object.keys(result.attributes).length) node.attributes = { ...node.attributes, ...result.attributes };
}
export function readLabel(source: string): { value: string; length: number } | undefined {
  if (source[0] !== "[") return;
  let depth = 1;
  let code = "";
  // An unmatched backtick run is text. Only matched code delimiters shield
  // brackets, and backslashes inside code do not escape those delimiters.
  let lastTick: Map<number,number> | undefined;
  for (let i = 1; i < source.length; i++) {
    const c = source[i];
    if (c === "\\" && !code) { i++; continue; }
    if (c === "`") {
      if(!lastTick) {
        lastTick=new Map();
        for(const match of source.matchAll(/`+/g)) lastTick.set(match[0].length,match.index);
      }
      const marks = /^`+/.exec(source.slice(i))![0];
      if (!code && lastTick.get(marks.length)!>i) code = marks; else if (code === marks) code = "";
      i += marks.length - 1;
      continue;
    }
    if (code) continue;
    if (c === "[") depth++;
    if (c === "]" && --depth === 0) {
      const value = source.slice(1, i);
      if (/^[ \t]|[ \t]$|\n/.test(value)) return;
      return {value, length:i + 1};
    }
  }
  return;
}
/** Split whitespace-separated attribute lists that end `text`, as headings do. */
export function trailingAttributeLists(text: string, options: ConversionOptions = {}): { text: string; lists: AttributeResult[] } {
  for (let i = 0; i < text.length; i++) if (text[i] === "{" && /[ \t]/.test(text[i-1] ?? "")) {
    let position = i; const lists: AttributeResult[] = [];
    while (position < text.length) {
      const attrs = readAttributes(text.slice(position), options); if (!attrs) break;
      lists.push(attrs); position += attrs.length;
      position += /^[ \t]*/.exec(text.slice(position))![0].length;
    }
    if (position === text.length && lists.length) return { text: text.slice(0, i).trimEnd(), lists };
  }
  return { text, lists: [] };
}
export function readHeader(source: string, options: ConversionOptions = {}, unbracketed = false): Node | undefined {
  let cursor = /^[ \t]*/.exec(source)![0].length;
  const name = tokenIdentifier(source.slice(cursor));
  if (!name) return;
  cursor += name.length;
  const node: Node = {type:"container", subType:name.toLowerCase(), body:[]};
  while (cursor < source.length) {
    cursor += /^[ \t]*/.exec(source.slice(cursor))![0].length;
    if (cursor === source.length) break;
    if (source[cursor] === "[") {
      if (node.title) return;
      const label = readLabel(source.slice(cursor));
      if (!label) return;
      node.title = {type:"title", value:label.value};
      cursor += label.length;
    } else if (source[cursor] === "{" || !unbracketed || node.title) {
      const attrs = readAttributes(source.slice(cursor), options);
      if (!attrs) return;
      attach(node, attrs); cursor += attrs.length;
    } else {
      // Unbracketed title: the rest of the line, up to trailing attribute lists.
      const { text, lists } = trailingAttributeLists(source.slice(cursor).trimEnd(), options);
      node.title = {type:"title", value:text}; node.titleSpelling = "unbracketed";
      for (const attrs of lists) attach(node, attrs);
      break;
    }
  }
  return node;
}
export function quoteAttribute(value: string): string {
  if(/[\r\n]/.test(value) || value.includes(String.fromCharCode(0))) throw new ConversionError("unsupported-conversion","An attribute value cannot contain a newline or NUL.");
  return `"${value.replace(/\\/g,"\\\\").replace(/"/g,'\\"')}"`;
}
export function writeAttributes(node: Node, extra: Attributes = {}): string {
  const entries = { ...node.attributes, ...extra };
  const output: string[] = [];
  if (node.id !== undefined && /[\r\n]/.test(node.id)) throw new ConversionError("unsupported-conversion","A node attachment ID must fit on one source line.");
  if (node.id !== undefined) output.push(`id=${quoteAttribute(node.id)}`);
  for (const [key, value] of Object.entries(entries)) {
    const name = sourceKey(key);
    output.push(typeof value === "boolean" ? `${value ? "" : "!"}${name}` : `${name}=${quoteAttribute(value)}`);
  }
  return output.length ? `{${output.join(" ")}}` : "";
}
/** CommonMark label matching: trimmed, whitespace collapsed and case-folded. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase();
}
export function plainText(node: Node): string {
  if (node.type === "break" || node.type === "softBreak") return " ";
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  return node.value ?? (node.children ?? node.body ?? []).map(plainText).join("");
}
export function compact(node: Node, children: Node[]): Node {
  const merged: Node[] = [];
  for (const child of children) {
    if (child.type === "text" && !child.value) continue;
    const last = merged.at(-1);
    if (last?.type === "text" && child.type === "text" && Object.keys(last).length === 2 && Object.keys(child).length === 2) last.value! += child.value;
    else merged.push(child);
  }
  if (merged.every(child => child.type === "text" && Object.keys(child).length === 2)) node.value = merged.map(child => child.value).join("");
  else node.children = merged;
  return node;
}

export function diagnoseIds(node: Node, options: ConversionOptions, seen=new Set<string>()): void {
  if(node.id !== undefined) { if(seen.has(node.id)) warn(options,"duplicate-id",`Authored ID ${node.id} occurs more than once; it was preserved.`); seen.add(node.id); }
  if(typeof node.title === "object" && node.title !== null) diagnoseIds(node.title,options,seen);
  for(const child of node.body ?? node.children ?? []) diagnoseIds(child,options,seen);
}
