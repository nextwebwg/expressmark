import type { Engine, StateBlock, StateInline, Token } from "./markdown/engine.js";
import type { Ruler } from "./markdown/ruler.js";
import { readItem, skipBulletListMarker, skipOrderedListMarker } from "./markdown/block.js";
import { rawTextElements, readElement, readStartTag, type ElementExtent } from "./html.js";
import type { ConversionOptions } from "./types.js";
import { linting, warn } from "./types.js";

/** The rules `standard` syntax changes; `compatible` syntax keeps CommonMark and GFM's. */
export const standardRules = ["html","indentedCode","setext","spaceBreaks","tableCode","lazy","bullets","spacedTargets","relativeLists","looseLists","lastDefinition"] as const;
export type StandardRule = typeof standardRules[number];
type BlockRule = (state: StateBlock, start: number, end: number, silent: boolean) => boolean;
type InlineRule = (state: StateInline, silent: boolean) => boolean;
const entry = <T,>(ruler: Ruler<T>, name: string) => ruler.get(name);

const trim = (value: string) => value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");

// A parse's options travel with its reader state, so one reader serves every parse.
const optionsOf = (state: { env: Record<string, unknown> }) => state.env.options as ConversionOptions;

/** Install `standard` syntax's rules on a reader. */
export function installStandard(md: Engine, lexical: Engine, rules: ReadonlySet<StandardRule>): void {
  const on = (rule: StandardRule) => rules.has(rule);
  const block = md.block.ruler;
  if (on("indentedCode")) {
    block.disable("code"); lexical.block.ruler.disable("code");
    // Indentation never makes code, so a block that CommonMark reads only below
    // four columns of indentation reads at any indentation.
    for (const name of ["table","fence","blockquote","hr","heading","reference","footnote_definition","expressive_container","expressive_leaf","expressive_line_block"]) {
      const rule = entry<BlockRule>(block, name); if (!rule) continue;
      const fn = rule.fn;
      block.at(name, (state, start, end, silent) => {
        if (state.sCount[start]! - state.blkIndent < 4) return fn(state, start, end, silent);
        const saved = state.blkIndent;
        state.blkIndent = state.sCount[start]!;
        try { return fn(state, start, end, silent); } finally { state.blkIndent = saved; }
      }, { alt: [...rule.alt] });
    }
  }
  if (on("setext")) block.disable("lheading");
  if (on("lazy")) {
    // Every line of a quote carries its own marker.
    const rule = entry<BlockRule>(block, "blockquote")!; const fn = rule.fn;
    block.at("blockquote", (state, start, end, silent) => {
      let last = start + 1;
      while (last < end && state.src[state.bMarks[last]! + state.tShift[last]!] === ">" && state.sCount[last]! >= state.blkIndent) last++;
      return fn(state, start, last, silent);
    }, { alt: [...rule.alt] });
  }
  if (on("lazy") || on("indentedCode")) block.at("paragraph", (state, start, end) => paragraph(state, start, end, on("lazy"), on("indentedCode")));
  if (on("relativeLists") || on("bullets") || on("looseLists") || on("indentedCode")) {
    const rule = entry<BlockRule>(block, "list")!;
    block.at("list", (state, start, end, silent) => list(state, start, end, silent, rules, optionsOf(state)), { alt: [...rule.alt] });
  }
  if (on("tableCode")) {
    const rule = entry<BlockRule>(block, "table")!; const fn = rule.fn;
    block.at("table", (state, start, end, silent) => maskCodePipes(state, start, end, () => fn(state, start, end, silent)), { alt: [...rule.alt] });
  }
  if (on("html")) {
    const rule = entry<BlockRule>(block, "html_block")!;
    block.at("html_block", (state, start, end, silent) => htmlElement(state, start, end, silent, optionsOf(state)), { alt: [...rule.alt] });
    md.inline.ruler.before("autolink", "standard_raw_text", (state, silent) => rawText(state, silent, optionsOf(state)));
  }
  if (on("spaceBreaks")) {
    // Trailing spaces are insignificant; a break is a trailing backslash or `<br>`.
    const fn = entry<InlineRule>(md.inline.ruler, "newline")!.fn;
    md.inline.ruler.at("newline", (state, silent) => {
      const count = state.tokens.length;
      if (!fn(state, silent)) return false;
      for (const token of state.tokens.slice(count)) if (token.type === "hardbreak") { token.type = "softbreak"; token.tag = ""; token.meta = null; }
      return true;
    });
  }
  if (on("spacedTargets")) {
    md.inline.ruler.before("link", "standard_spaced_link", (state, silent) => spacedTarget(state, silent, false));
    md.inline.ruler.before("image", "standard_spaced_image", (state, silent) => spacedTarget(state, silent, true));
  }
}

// CommonMark's paragraph, without lazy continuation lines or indentation that
// shields a line from interrupting it, as the options select.
function paragraph(state: StateBlock, start: number, end: number, noLazy: boolean, noIndentedCode: boolean): boolean {
  const terminators = state.md.block.ruler.getRules("paragraph");
  const parent = state.parentType;
  let next = start + 1;
  state.parentType = "paragraph";
  for (; next < end && !state.isEmpty(next); next++) {
    if (noLazy && state.sCount[next]! < state.blkIndent) break;
    if (!noIndentedCode && state.sCount[next]! - state.blkIndent > 3) continue;
    if (state.sCount[next]! < 0) continue;
    if (terminators.some(rule => rule(state, next, end, true))) break;
  }
  const content = trim(state.getLines(start, next, state.blkIndent, false));
  state.line = next;
  state.push("paragraph_open", "p", 1).map = [start, next];
  const inline = state.push("inline", "", 0);
  inline.content = content; inline.map = [start, next]; inline.children = [];
  state.push("paragraph_close", "p", -1);
  state.parentType = parent;
  return true;
}

const leading = (state: StateBlock, line: number) => state.src.slice(state.bMarks[line]!, state.bMarks[line]! + state.tShift[line]!);
const unrelated = (a: string, b: string) => !a.startsWith(b) && !b.startsWith(a);

// CommonMark's list rule with `standard` syntax's choices: a line indented past
// its item's marker belongs to the item, any bullet or ordered delimiter
// continues the list, and a blank line between items ends the list.
function list(state: StateBlock, startLine: number, endLine: number, silent: boolean, rules: ReadonlySet<StandardRule>, options: ConversionOptions): boolean {
  const relative = rules.has("relativeLists"), anyMarker = rules.has("bullets"), split = rules.has("looseLists"), anyIndent = rules.has("indentedCode");
  let line = startLine;
  if (!anyIndent && state.sCount[line]! - state.blkIndent >= 4) return false;
  if (!anyIndent && state.listIndent >= 0 && state.sCount[line]! - state.listIndent >= 4 && state.sCount[line]! < state.blkIndent) return false;
  const terminating = silent && state.parentType === "paragraph" && state.sCount[line]! >= state.blkIndent;
  let ordered: boolean, value = 1, start = 0;
  let after = skipOrderedListMarker(state, line);
  if (after >= 0) {
    ordered = true;
    start = state.bMarks[line]! + state.tShift[line]!;
    value = Number(state.src.slice(start, after - 1));
    if (terminating && value !== 1) return false;
  } else if ((after = skipBulletListMarker(state, line)) >= 0) ordered = false;
  else return false;
  if (terminating && state.skipSpaces(after) >= state.eMarks[line]!) return false;
  if (silent) return true;
  const marker = state.src.charCodeAt(after - 1);
  const listIndex = state.tokens.length;
  const open = state.push(ordered ? "ordered_list_open" : "bullet_list_open", ordered ? "ol" : "ul", 1);
  if (ordered && value !== 1) open.attrs = [["start", String(value)]];
  const lines: [number, number] = [line, 0];
  open.map = lines;
  open.markup = String.fromCharCode(marker);
  let tight = true, emptyEnd = false, mixed = false;
  const terminators = state.md.block.ruler.getRules("list");
  const parent = state.parentType;
  const firstLead = leading(state, line);
  state.parentType = "list";
  while (line < endLine) {
    let pos = after;
    const max = state.eMarks[line]!;
    const initial = state.sCount[line]! + after - (state.bMarks[line]! + state.tShift[line]!);
    let offset = initial;
    while (pos < max) {
      const code = state.src.charCodeAt(pos);
      if (code === 0x09) offset += 4 - (offset + state.bsCount[line]!) % 4;
      else if (code === 0x20) offset++;
      else break;
      pos++;
    }
    const contentStart = pos;
    let indentAfter = contentStart >= max ? 1 : offset - initial;
    if (indentAfter > 4) indentAfter = 1;
    // A relative item holds every line indented past its marker.
    const indent = relative ? state.sCount[line]! + 1 : initial + indentAfter;
    const itemMarker = state.src.charCodeAt(after - 1);
    const item = state.push("list_item_open", "li", 1);
    item.markup = String.fromCharCode(itemMarker);
    const itemLines: [number, number] = [line, 0];
    item.map = itemLines;
    if (ordered) item.info = state.src.slice(start, after - 1);
    if (itemMarker !== marker) item.meta = { marker: String.fromCharCode(itemMarker) };
    const itemIndex = state.tokens.length;
    const lead = leading(state, line);
    if (unrelated(lead, firstLead)) mixed = true;
    const saved = { tight: state.tight, bMark: state.bMarks[line]!, tShift: state.tShift[line]!, sCount: state.sCount[line]!, listIndent: state.listIndent };
    state.listIndent = state.blkIndent;
    state.blkIndent = indent;
    state.tight = true;
    // A relative item's first line starts at its content, since the item's
    // indentation is narrower than its marker.
    if (relative) { state.bMarks[line] = contentStart; state.tShift[line] = 0; state.sCount[line] = offset; }
    else { state.tShift[line] = contentStart - state.bMarks[line]!; state.sCount[line] = offset; }
    readItem(state, line, endLine, after, contentStart >= max);
    const itemTight = state.tight;
    if (!state.tight || emptyEnd) tight = false;
    emptyEnd = state.line - line > 1 && state.isEmpty(state.line - 1);
    for (let index = line + 1; index < state.line; index++) if (!state.isEmpty(index) && unrelated(leading(state, index), lead)) mixed = true;
    state.blkIndent = state.listIndent;
    state.listIndent = saved.listIndent;
    state.bMarks[line] = saved.bMark;
    state.tShift[line] = saved.tShift;
    state.sCount[line] = saved.sCount;
    state.tight = saved.tight;
    if (split) {
      // Each item is tight unless it holds blank-line-separated blocks.
      if (itemTight) hideParagraphs(state, itemIndex, state.level);
      else item.meta = { ...item.meta, loose: true };
    }
    state.push("list_item_close", "li", -1).markup = String.fromCharCode(itemMarker);
    line = state.line;
    itemLines[1] = line;
    if (line >= endLine) break;
    if (split && emptyEnd) break;
    if (state.sCount[line]! < state.blkIndent) break;
    if (!anyIndent && state.sCount[line]! - state.blkIndent >= 4) break;
    if (terminators.some(rule => rule(state, line, endLine, true))) break;
    if (ordered) {
      after = skipOrderedListMarker(state, line);
      if (after < 0) break;
      start = state.bMarks[line]! + state.tShift[line]!;
    } else {
      after = skipBulletListMarker(state, line);
      if (after < 0) break;
    }
    if (!anyMarker && marker !== state.src.charCodeAt(after - 1)) break;
  }
  if (mixed) warn(options, "mixed-indentation", "A list mixes tabs and spaces in its indentation; tabs count to the next multiple of four columns.");
  state.push(ordered ? "ordered_list_close" : "bullet_list_close", ordered ? "ol" : "ul", -1).markup = String.fromCharCode(marker);
  lines[1] = line;
  state.line = line;
  state.parentType = parent;
  if (!split && tight) hideParagraphs(state, listIndex + 1, state.level + 2);
  return true;
}
function hideParagraphs(state: StateBlock, from: number, level: number): void {
  for (let index = from; index < state.tokens.length - 2; index++) if (state.tokens[index]!.level === level && state.tokens[index]!.type === "paragraph_open") {
    state.tokens[index]!.hidden = true; state.tokens[index + 2]!.hidden = true; index += 2;
  }
}

// A code span inside a table cell is literal, its pipes included: they are
// masked while GFM's table rule splits the row.
function maskCodePipes(state: StateBlock, start: number, end: number, run: () => boolean): boolean {
  if (start + 1 >= end || !/^[|:\- \t]*-[|:\- \t]*$/.test(state.src.slice(state.bMarks[start + 1]! + state.tShift[start + 1]!, state.eMarks[start + 1]))) return run();
  let last = start;
  while (last < end && !state.isEmpty(last)) last++;
  const from = state.bMarks[start]!, to = state.eMarks[last - 1]!;
  const region = state.src.slice(from, to);
  const mask = "";
  if (!region.includes("`") || state.src.includes(mask)) return run();
  const masked = region.split("\n").map(row => row.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, code => code.replaceAll("|", mask))).join("\n");
  if (masked === region) return run();
  const original = state.src;
  const count = state.tokens.length;
  state.src = original.slice(0, from) + masked + original.slice(to);
  try { return run(); } finally {
    state.src = original;
    for (const token of state.tokens.slice(count)) if (token.content.includes(mask)) token.content = token.content.replaceAll(mask, "|");
  }
}

// An element that begins a line is a block, running to where HTML closes it.
// Elements separated only by whitespace on a line are each a block; an
// element followed by text on its line is inline content of a paragraph.
interface Chained { extent: ElementExtent; at: number }
function chain(source: string, from: number, limit: number, lineEnd: (offset: number) => number): Chained[] | undefined {
  const found: Chained[] = [];
  let at = from;
  for (;;) {
    const extent = readElement(source, at, limit);
    if (!extent) return;
    found.push({ extent, at });
    // An element closed at the start of a line leaves that line to the next block.
    if (extent.end > from && source[extent.end - 1] === "\n") return found;
    const rest = source.slice(extent.end, lineEnd(extent.end));
    if (!rest.trim()) return found;
    const gap = /^[ \t]*/.exec(rest)![0].length;
    if (!/^<[A-Za-z]/.test(rest.slice(gap))) return;
    at = extent.end + gap;
  }
}
function firstBlank(state: StateBlock, start: number, end: number): number | undefined {
  let fence: string | undefined;
  for (let line = start + 1; line < end; line++) {
    const text = state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]);
    const marker = /^(`{3,}|~{3,})/.exec(text)?.[1];
    if (marker && (!fence || marker[0] === fence[0] && marker.length >= fence.length && !text.slice(marker.length).trim())) fence = fence ? undefined : marker;
    else if (!fence && state.isEmpty(line)) return line;
  }
  return;
}
function htmlElement(state: StateBlock, start: number, end: number, silent: boolean, options: ConversionOptions): boolean {
  const pos = state.bMarks[start]! + state.tShift[start]!;
  if (state.src[pos] !== "<") return false;
  let limit = state.eMarks[end - 1]!;
  const lineOf = (offset: number) => { let line = start; while (line < end - 1 && state.eMarks[line]! < offset) line++; return line; };
  const head = state.src.slice(pos, pos + 9);
  const markup = /^<(!--|\?|!\[CDATA\[|![A-Za-z])/.exec(head);
  const closing = /^<\/([A-Za-z][A-Za-z0-9-]*)[^>]*>/.exec(state.src.slice(pos, pos + 256));
  let last: number;
  if (markup) {
    // Comments and declarations take the rest of their last line, as CommonMark's do.
    const terminator = ({"!--":"-->","?":"?>","![CDATA[":"]]>"} as Record<string,string>)[markup[1]!] ?? ">";
    const close = state.src.indexOf(terminator, pos + 2);
    last = lineOf(close < 0 || close >= limit ? limit : close + terminator.length);
  } else if (closing) {
    // A closing tag never creates an element: a stray one is ignored.
    if (state.src.slice(pos + closing[0].length, state.eMarks[start]).trim()) return false;
    if (silent) return true;
    if (closing[1]!.toLowerCase() === "br") {
      // Authors write </br> to mean a line break.
      if (linting(options.lint, "br-end-tag")) options.onDiagnostic?.({ code: "br-end-tag", message: "</br> is read as <br>; write <br>.", severity: "warning", preferred: "<br>" });
      const token = state.push("html_element", "", 0);
      token.map = [start, start + 1]; token.meta = { name: "br", open: closing[0] };
    } else {
      warn(options, "stray-end-tag", `${closing[0]} closes no open element; it is ignored.`);
      const token = state.push("html_block", "", 0);
      token.content = closing[0]; token.map = [start, start + 1]; token.meta = { stray: true };
    }
    state.line = start + 1;
    return true;
  } else {
    // An element ends with its enclosing block, such as a list item.
    for (let line = start + 1; line < end; line++) if (!state.isEmpty(line) && state.sCount[line]! < state.blkIndent) { limit = state.eMarks[line - 1]!; break; }
    const lineEnd = (offset: number) => state.eMarks[lineOf(offset)]!;
    let found = chain(state.src, pos, limit, lineEnd);
    // An element without its end tag ends at its first blank line outside code.
    if (found?.some(({ extent }) => extent.closed === false)) {
      const blank = firstBlank(state, start, end);
      if (blank !== undefined && state.eMarks[blank - 1]! < limit) { limit = state.eMarks[blank - 1]!; found = chain(state.src, pos, limit, lineEnd); }
    }
    if (!found) return false;
    // An element interrupts a paragraph when it runs past its first line or its
    // start tag ends the line; a one-line element continues the paragraph's text.
    const first = found[0]!.extent;
    if (silent && state.parentType === "paragraph" && (first.closed === "void" || first.closed === "self" || state.src.slice(first.tagEnd, state.eMarks[start]).trim() && lineOf(first.end) === start)) return false;
    const final = found.at(-1)!.extent.end;
    last = lineOf(state.src[final - 1] === "\n" ? final - 1 : final);
  }
  if (silent) return true;
  const text = state.getLines(start, last + 1, state.blkIndent, false).replace(/\n$/, "");
  const map: [number, number] = [start, last + 1];
  if (markup) {
    const token = state.push("html_block", "", 0);
    token.content = text; token.map = map;
  } else {
    const at = text.indexOf("<");
    for (const { extent, at: begin } of chain(text, at, text.length, offset => { const next = text.indexOf("\n", offset); return next < 0 ? text.length : next; }) ?? []) {
      const tag = text.slice(begin, extent.tagEnd);
      if (extent.closed === false) warn(options, "unclosed-html-element", `<${extent.name}> has no closing tag; it ends at its first blank line.`);
      const token = state.push("html_element", "", 0);
      token.map = map;
      const inner = text.slice(extent.tagEnd, extent.closeStart);
      token.meta = {
        name: extent.name, open: tag,
        ...(extent.closed === "tag" ? { close: text.slice(extent.closeStart, extent.end) } : {}),
        ...(extent.closed === "void" || extent.closed === "self" ? {} : rawTextElements.has(extent.name) ? { value: inner } : { content: inner }),
      };
    }
  }
  state.line = last + 1;
  return true;
}
// A raw-text element inside a paragraph holds its content as written, through
// its end tag or the paragraph's end.
function rawText(state: StateInline, silent: boolean, options: ConversionOptions): boolean {
  if (state.src[state.pos] !== "<") return false;
  const tag = readStartTag(state.src, state.pos, state.posMax);
  if (!tag || tag.selfClosing || !rawTextElements.has(tag.name)) return false;
  const close = new RegExp(`</${tag.name}(?=[\\s/>])[^>]*>`, "ig");
  close.lastIndex = tag.end;
  const found = close.exec(state.src);
  const closed = found && found.index + found[0].length <= state.posMax ? found : undefined;
  if (!silent) {
    if (!closed) warn(options, "unclosed-html-element", `<${tag.name}> has no closing tag; it ends with its paragraph.`);
    const token = state.push("html_raw_inline", "", 0);
    token.meta = { name: tag.name, open: state.src.slice(state.pos, tag.end), value: state.src.slice(tag.end, closed ? closed.index : state.posMax), ...(closed ? { close: closed[0] } : {}) };
  }
  state.pos = closed ? closed.index + closed[0].length : state.posMax;
  return true;
}

// A link or image target holding spaces: it runs to the `)` that balances the
// opening one on the same line, and a final quoted title stays the title.
function spacedTarget(state: StateInline, silent: boolean, image: boolean): boolean {
  const begin = state.pos;
  if (image ? state.src[begin] !== "!" || state.src[begin + 1] !== "[" : state.src[begin] !== "[") return false;
  const labelStart = begin + (image ? 2 : 1);
  const labelEnd = state.md.helpers.parseLinkLabel(state, labelStart - 1, !image);
  if (labelEnd < 0 || state.src[labelEnd + 1] !== "(") return false;
  let depth = 1, cursor = labelEnd + 2;
  for (; cursor < state.posMax; cursor++) {
    const char = state.src[cursor];
    if (char === "\n") return false;
    if (char === "\\") { cursor++; continue; }
    if (char === "(") depth++;
    else if (char === ")" && --depth === 0) break;
  }
  if (depth) return false;
  const inner = state.src.slice(labelEnd + 2, cursor);
  const parts = /^[ \t]*([\s\S]*?)(?:[ \t]+("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'))?[ \t]*$/.exec(inner)!;
  const target = parts[1]!;
  // Targets without spaces, and angle-bracket targets, keep CommonMark's reading.
  if (!/[ \t]/.test(target) || target.startsWith("<")) return false;
  const href = state.md.normalizeLink(state.md.utils.unescapeAll(target));
  if (!state.md.validateLink(href)) return false;
  const title = parts[2] === undefined ? undefined : state.md.utils.unescapeAll(parts[2].slice(1, -1));
  if (!silent) {
    const max = state.posMax;
    const meta = { target: `(${inner})` };
    if (image) {
      const children: Token[] = [];
      state.md.inline.parse(state.src.slice(labelStart, labelEnd), state.md, state.env, children);
      const token = state.push("image", "img", 0);
      token.attrs = [["src", href], ["alt", ""], ...(title === undefined ? [] : [["title", title] as [string, string]])];
      token.children = children; token.content = state.src.slice(labelStart, labelEnd); token.meta = meta;
    } else {
      state.pos = labelStart; state.posMax = labelEnd;
      const token = state.push("link_open", "a", 1);
      token.attrs = [["href", href], ...(title === undefined ? [] : [["title", title] as [string, string]])];
      token.meta = meta;
      state.linkLevel++; state.md.inline.tokenize(state); state.linkLevel--;
      state.push("link_close", "a", -1);
      state.posMax = max;
    }
  }
  state.pos = cursor + 1;
  return true;
}
