// The block reader. Lines are read as CommonMark's container algorithm reads
// them: each container narrows the lines its content sees (`bMarks`, `tShift`,
// `sCount`), and leaf rules ask the lexicon what starts a line. The behavior
// follows markdown-it 15.0.3; see the notice in engine.ts.
import { Ruler } from "./ruler.js";
import { Token } from "./token.js";
import { asciiTrim, isSpace, normalizeReference } from "./utils.js";
import { atxHeading, bulletMarker, definitionMarker, fenceClose, fenceOpen, htmlBlockStart, match, orderedMarker, reach, setextUnderline, tableCells, tableDelimiterRow, thematicBreak } from "./lexicon.js";
import { parseLinkDestination, parseLinkTitle } from "./links.js";
import { lines, type Combinator, type ParseContext } from "parseman";
import type { Engine } from "./engine.js";

export type BlockRule = (state: StateBlock, startLine: number, endLine: number, silent: boolean) => boolean;
export type Env = Record<string, unknown> & { references?: Record<string, { href: string; title: string }> };

export class StateBlock {
  src: string;
  md: Engine;
  env: Env;
  tokens: Token[];
  /** Each line's start, end, indentation length, indentation width and the width its containers took. */
  bMarks: number[] = [];
  eMarks: number[] = [];
  tShift: number[] = [];
  sCount: number[] = [];
  bsCount: number[] = [];
  blkIndent = 0;
  line = 0;
  lineMax = 0;
  tight = false;
  listIndent = -1;
  parentType = "root";
  level = 0;
  /** The container run being collected; see `readRun`. */
  run: Run = { start: 0, line: 0, at: -1, endLine: 0, firstEnd: 0, lastEmpty: false, terminated: false, read: () => {} };
  context: ParseContext | undefined;
  /** A top-level line where reading stops, for reading part of a document. */
  stop: ((line: number) => boolean) | undefined;
  constructor(src: string, md: Engine, env: Env, tokens: Token[]) {
    this.src = src; this.md = md; this.env = env; this.tokens = tokens;
    let start = 0, indent = 0, offset = 0, indented = true;
    for (let pos = 0, length = src.length; pos < length; pos++) {
      const code = src.charCodeAt(pos);
      if (indented) {
        if (isSpace(code)) { indent++; offset += code === 0x09 ? 4 - offset % 4 : 1; continue; }
        indented = false;
      }
      if (code === 0x0a || pos === length - 1) {
        if (code !== 0x0a) pos++;
        this.bMarks.push(start); this.eMarks.push(pos); this.tShift.push(indent); this.sCount.push(offset); this.bsCount.push(0);
        indented = true; indent = 0; offset = 0; start = pos + 1;
      }
    }
    // A sentinel line after the last one simplifies lookahead.
    this.bMarks.push(src.length); this.eMarks.push(src.length); this.tShift.push(0); this.sCount.push(0); this.bsCount.push(0);
    this.lineMax = this.bMarks.length - 1;
  }
  push(type: string, tag: string, nesting: -1 | 0 | 1): Token {
    const token = new Token(type, tag, nesting);
    token.block = true;
    if (nesting < 0) this.level--;
    token.level = this.level;
    if (nesting > 0) this.level++;
    this.tokens.push(token);
    return token;
  }
  isEmpty(line: number): boolean { return this.bMarks[line]! + this.tShift[line]! >= this.eMarks[line]!; }
  skipEmptyLines(from: number): number {
    for (const max = this.lineMax; from < max; from++) if (this.bMarks[from]! + this.tShift[from]! < this.eMarks[from]!) break;
    return from;
  }
  skipSpaces(pos: number): number {
    for (const max = this.src.length; pos < max; pos++) if (!isSpace(this.src.charCodeAt(pos))) break;
    return pos;
  }
  skipChars(pos: number, code: number): number {
    for (const max = this.src.length; pos < max; pos++) if (this.src.charCodeAt(pos) !== code) break;
    return pos;
  }
  /** The text of lines `[begin, end)` with `indent` columns of each removed; a tab a container split keeps its remainder as spaces. */
  getLines(begin: number, end: number, indent: number, keepLastLF: boolean): string {
    if (begin >= end) return "";
    const queue: string[] = [];
    for (let line = begin; line < end; line++) {
      let lineIndent = 0;
      const lineStart = this.bMarks[line]!;
      let first = lineStart;
      const last = line + 1 < end || keepLastLF ? this.eMarks[line]! + 1 : this.eMarks[line]!;
      while (first < last && lineIndent < indent) {
        const code = this.src.charCodeAt(first);
        if (isSpace(code)) lineIndent += code === 0x09 ? 4 - (lineIndent + this.bsCount[line]!) % 4 : 1;
        else if (first - lineStart < this.tShift[line]!) lineIndent++;
        else break;
        first++;
      }
      queue.push(lineIndent > indent ? " ".repeat(lineIndent - indent) + this.src.slice(first, last) : this.src.slice(first, last));
    }
    return queue.join("");
  }
  /** A line's text after its indentation. */
  lineText(line: number): string { return this.src.slice(this.bMarks[line]! + this.tShift[line]!, this.eMarks[line]); }
}

const terminates = (rules: BlockRule[], state: StateBlock, line: number, endLine: number): boolean => {
  for (const rule of rules) if (rule(state, line, endLine, true)) return true;
  return false;
};

// ---- Leaf blocks

const MAX_AUTOCOMPLETED_CELLS = 0x10000;
function rowCells(text: string): string[] {
  const cells = match(tableCells, text, 0)!;
  if (cells.length && cells[0] === "") cells.shift();
  if (cells.length && cells.at(-1) === "") cells.pop();
  return cells;
}
const table: BlockRule = (state, startLine, endLine, silent) => {
  if (startLine + 2 > endLine) return false;
  let nextLine = startLine + 1;
  if (state.sCount[nextLine]! < state.blkIndent || state.sCount[nextLine]! - state.blkIndent >= 4) return false;
  const aligns = match(tableDelimiterRow, state.src, state.bMarks[nextLine]! + state.tShift[nextLine]!);
  if (!aligns) return false;
  const header = state.lineText(startLine).trim();
  if (!header.includes("|") || state.sCount[startLine]! - state.blkIndent >= 4) return false;
  let columns = rowCells(header);
  const columnCount = columns.length;
  if (columnCount === 0 || columnCount !== aligns.length) return false;
  if (silent) return true;
  const oldParentType = state.parentType;
  state.parentType = "table";
  const terminators = state.md.block.ruler.getRules("blockquote");
  const open = state.push("table_open", "table", 1);
  const tableLines: [number, number] = [startLine, 0];
  open.map = tableLines;
  state.push("thead_open", "thead", 1).map = [startLine, startLine + 1];
  state.push("tr_open", "tr", 1).map = [startLine, startLine + 1];
  const cell = (tag: "th" | "td", index: number, content: string) => {
    const cellOpen = state.push(`${tag}_open`, tag, 1);
    if (aligns[index]) cellOpen.attrs = [["style", `text-align:${aligns[index]}`]];
    const inline = state.push("inline", "", 0);
    inline.content = content; inline.children = [];
    state.push(`${tag}_close`, tag, -1);
  };
  for (let i = 0; i < columns.length; i++) cell("th", i, columns[i]!.trim());
  state.push("tr_close", "tr", -1);
  state.push("thead_close", "thead", -1);
  let bodyLines: [number, number] | undefined;
  let autocompleted = 0;
  for (nextLine = startLine + 2; nextLine < endLine; nextLine++) {
    if (state.sCount[nextLine]! < state.blkIndent) break;
    if (terminates(terminators, state, nextLine, endLine)) break;
    const text = state.lineText(nextLine).trim();
    if (!text || state.sCount[nextLine]! - state.blkIndent >= 4) break;
    columns = rowCells(text);
    autocompleted += columnCount - columns.length;
    if (autocompleted > MAX_AUTOCOMPLETED_CELLS) break;
    if (nextLine === startLine + 2) state.push("tbody_open", "tbody", 1).map = bodyLines = [startLine + 2, 0];
    state.push("tr_open", "tr", 1).map = [nextLine, nextLine + 1];
    for (let i = 0; i < columnCount; i++) cell("td", i, columns[i] ? columns[i]!.trim() : "");
    state.push("tr_close", "tr", -1);
  }
  if (bodyLines) { state.push("tbody_close", "tbody", -1); bodyLines[1] = nextLine; }
  state.push("table_close", "table", -1);
  tableLines[1] = nextLine;
  state.parentType = oldParentType;
  state.line = nextLine;
  return true;
};

const code: BlockRule = (state, startLine, endLine) => {
  if (state.sCount[startLine]! - state.blkIndent < 4) return false;
  let nextLine = startLine + 1, last = nextLine;
  while (nextLine < endLine) {
    if (state.isEmpty(nextLine)) { nextLine++; continue; }
    if (state.sCount[nextLine]! - state.blkIndent >= 4) { last = ++nextLine; continue; }
    break;
  }
  state.line = last;
  const token = state.push("code_block", "code", 0);
  token.content = `${state.getLines(startLine, last, 4 + state.blkIndent, false)}\n`;
  token.map = [startLine, state.line];
  return true;
};

const fence: BlockRule = (state, startLine, endLine, silent) => {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const opened = match(fenceOpen, state.src, state.bMarks[startLine]! + state.tShift[startLine]!);
  if (!opened) return false;
  if (silent) return true;
  const marker = opened.markup.charCodeAt(0), length = opened.markup.length;
  let nextLine = startLine, closed = false;
  for (;;) {
    nextLine++;
    if (nextLine >= endLine) break;
    const pos = state.bMarks[nextLine]! + state.tShift[nextLine]!;
    if (pos < state.eMarks[nextLine]! && state.sCount[nextLine]! < state.blkIndent) break;
    if (state.src.charCodeAt(pos) !== marker || state.sCount[nextLine]! - state.blkIndent >= 4) continue;
    const closing = match(fenceClose, state.src, pos);
    if (closing === undefined || closing.charCodeAt(0) !== marker || closing.length < length) continue;
    closed = true;
    break;
  }
  state.line = nextLine + (closed ? 1 : 0);
  const token = state.push("fence", "code", 0);
  token.info = opened.info;
  token.content = state.getLines(startLine + 1, nextLine, state.sCount[startLine]!, true);
  token.markup = opened.markup;
  token.map = [startLine, state.line];
  return true;
};

const hr: BlockRule = (state, startLine, _endLine, silent) => {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const markup = match(thematicBreak, state.src, state.bMarks[startLine]! + state.tShift[startLine]!);
  if (markup === undefined) return false;
  if (silent) return true;
  state.line = startLine + 1;
  const token = state.push("hr", "hr", 0);
  token.map = [startLine, state.line];
  token.markup = markup;
  return true;
};

const heading: BlockRule = (state, startLine, _endLine, silent) => {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const found = match(atxHeading, state.src, state.bMarks[startLine]! + state.tShift[startLine]!);
  if (!found) return false;
  if (silent) return true;
  state.line = startLine + 1;
  const marks = "#".repeat(found.level);
  const open = state.push("heading_open", `h${found.level}`, 1);
  open.markup = marks; open.map = [startLine, state.line];
  const inline = state.push("inline", "", 0);
  inline.content = asciiTrim(state.src.slice(found.start, found.end)); inline.map = [startLine, state.line]; inline.children = [];
  state.push("heading_close", `h${found.level}`, -1).markup = marks;
  return true;
};

const lheading: BlockRule = (state, startLine, endLine) => {
  const terminators = state.md.block.ruler.getRules("paragraph");
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const oldParentType = state.parentType;
  state.parentType = "paragraph";
  let level = 0, marker = "";
  let nextLine = startLine + 1;
  for (; nextLine < endLine && !state.isEmpty(nextLine); nextLine++) {
    if (state.sCount[nextLine]! - state.blkIndent > 3) continue;
    if (state.sCount[nextLine]! >= state.blkIndent) {
      const underline = match(setextUnderline, state.src, state.bMarks[nextLine]! + state.tShift[nextLine]!);
      if (underline !== undefined) { marker = underline[0]!; level = marker === "=" ? 1 : 2; break; }
    }
    if (state.sCount[nextLine]! < 0) continue;
    if (terminates(terminators, state, nextLine, endLine)) break;
  }
  if (!level) { state.parentType = oldParentType; return false; }
  const content = asciiTrim(state.getLines(startLine, nextLine, state.blkIndent, false));
  state.line = nextLine + 1;
  const open = state.push("heading_open", `h${level}`, 1);
  open.markup = marker; open.map = [startLine, state.line];
  const inline = state.push("inline", "", 0);
  inline.content = content; inline.map = [startLine, state.line - 1]; inline.children = [];
  state.push("heading_close", `h${level}`, -1).markup = marker;
  state.parentType = oldParentType;
  return true;
};

const paragraph: BlockRule = (state, startLine, endLine) => {
  const terminators = state.md.block.ruler.getRules("paragraph");
  const oldParentType = state.parentType;
  let nextLine = startLine + 1;
  state.parentType = "paragraph";
  for (; nextLine < endLine && !state.isEmpty(nextLine); nextLine++) {
    // Indented lines and lazy continuation lines cannot interrupt a paragraph.
    if (state.sCount[nextLine]! - state.blkIndent > 3 || state.sCount[nextLine]! < 0) continue;
    if (terminates(terminators, state, nextLine, endLine)) break;
  }
  const content = asciiTrim(state.getLines(startLine, nextLine, state.blkIndent, false));
  state.line = nextLine;
  state.push("paragraph_open", "p", 1).map = [startLine, state.line];
  const inline = state.push("inline", "", 0);
  inline.content = content; inline.map = [startLine, state.line]; inline.children = [];
  state.push("paragraph_close", "p", -1);
  state.parentType = oldParentType;
  return true;
};

const html_block: BlockRule = (state, startLine, endLine, silent) => {
  let pos = state.bMarks[startLine]! + state.tShift[startLine]!;
  if (state.sCount[startLine]! - state.blkIndent >= 4 || !state.md.options.html || state.src.charCodeAt(pos) !== 0x3c) return false;
  let lineText = state.src.slice(pos, state.eMarks[startLine]);
  const start = match(htmlBlockStart, lineText, 0);
  if (!start) return false;
  if (silent) return start.interrupts;
  let nextLine = startLine + 1;
  const endsOnBlankLine = start.end.test("");
  if (!start.end.test(lineText)) for (; nextLine < endLine; nextLine++) {
    if (state.sCount[nextLine]! < state.blkIndent && (endsOnBlankLine || !state.isEmpty(nextLine))) break;
    pos = state.bMarks[nextLine]! + state.tShift[nextLine]!;
    lineText = state.src.slice(pos, state.eMarks[nextLine]);
    if (start.end.test(lineText)) { if (lineText.length !== 0) nextLine++; break; }
  }
  state.line = nextLine;
  const token = state.push("html_block", "", 0);
  token.map = [startLine, nextLine];
  token.content = state.getLines(startLine, nextLine, state.blkIndent, true);
  return true;
};

// ---- Reference definitions

const MAX_LABEL_LENGTH = 999;
function countCodePoints(text: string): number {
  let length = text.length;
  for (let i = 0; i < text.length - 1; i++) {
    const high = text.charCodeAt(i);
    if (high < 0xd800 || high > 0xdbff) continue;
    const low = text.charCodeAt(i + 1);
    if (low >= 0xdc00 && low <= 0xdfff) { length--; i++; }
  }
  return length;
}
const lineEnd = (state: StateBlock, line: number) => Math.min(state.eMarks[line]! + 1, state.src.length);
// Where a definition continues on the next line, or -1 when another block starts there.
function nextLinePos(state: StateBlock, nextLine: number): number {
  if (nextLine >= state.lineMax || state.isEmpty(nextLine)) return -1;
  if (state.sCount[nextLine]! - state.blkIndent <= 3 && state.sCount[nextLine]! >= 0) {
    const oldParentType = state.parentType;
    state.parentType = "reference";
    const terminate = terminates(state.md.block.ruler.getRules("reference"), state, nextLine, state.lineMax);
    state.parentType = oldParentType;
    if (terminate) return -1;
  }
  return state.bMarks[nextLine]! + state.tShift[nextLine]!;
}
const reference: BlockRule = (state, startLine, _endLine, silent) => {
  const src = state.src;
  let pos = state.bMarks[startLine]! + state.tShift[startLine]!;
  let nextLine = startLine + 1;
  if (state.sCount[startLine]! - state.blkIndent >= 4 || src.charCodeAt(pos) !== 0x5b) return false;
  let max = lineEnd(state, startLine);
  let rawLabel = "";
  let labelEnd = -1;
  let segmentStart = ++pos;
  while (pos < max) {
    if (rawLabel.length + pos - segmentStart > MAX_LABEL_LENGTH * 2) return false;
    let code = src.charCodeAt(pos);
    if (code === 0x5b) return false;
    if (code === 0x5d) { labelEnd = pos; break; }
    if (code === 0x5c) code = src.charCodeAt(++pos);
    if (code === 0x0a && pos < max) {
      const next = nextLinePos(state, nextLine);
      if (next < 0) return false;
      rawLabel += src.slice(segmentStart, max);
      pos = segmentStart = next;
      max = lineEnd(state, nextLine++);
      continue;
    }
    pos++;
  }
  if (labelEnd < 0 || src.charCodeAt(labelEnd + 1) !== 0x3a) return false;
  rawLabel += src.slice(segmentStart, labelEnd);
  if (rawLabel.length > MAX_LABEL_LENGTH && countCodePoints(rawLabel) > MAX_LABEL_LENGTH) return false;
  // Spaces, and a line break into a continuation line, separate the parts.
  const skipGap = () => {
    while (pos < max) {
      const code = src.charCodeAt(pos);
      if (code === 0x0a) {
        const next = nextLinePos(state, nextLine);
        if (next < 0) break;
        pos = next; max = lineEnd(state, nextLine++);
      } else if (isSpace(code)) pos++;
      else break;
    }
  };
  pos = labelEnd + 2;
  skipGap();
  const destination = parseLinkDestination(src, pos, max);
  if (!destination.ok) return false;
  const href = state.md.normalizeLink(destination.str);
  if (!state.md.validateLink(href)) return false;
  pos = destination.pos;
  const destEndPos = pos, destEndMax = max, destEndLineNo = nextLine;
  skipGap();
  const titleStart = pos;
  let titleRes = parseLinkTitle(src, pos, max);
  while (titleRes.can_continue) {
    const next = nextLinePos(state, nextLine);
    if (next < 0) break;
    pos = next; max = lineEnd(state, nextLine++);
    titleRes = parseLinkTitle(src, pos, max, titleRes);
  }
  let title: string;
  if (titleStart !== destEndPos && titleRes.ok) { title = titleRes.str; pos = titleRes.pos; }
  else { title = ""; pos = destEndPos; max = destEndMax; nextLine = destEndLineNo; }
  while (pos < max && isSpace(src.charCodeAt(pos))) pos++;
  if (pos < max && src.charCodeAt(pos) !== 0x0a && title) {
    // Garbage after the title: the title is not part of the definition.
    title = ""; pos = destEndPos; max = destEndMax; nextLine = destEndLineNo;
    while (pos < max && isSpace(src.charCodeAt(pos))) pos++;
  }
  if (pos < max && src.charCodeAt(pos) !== 0x0a) return false;
  const label = normalizeReference(rawLabel);
  if (!label) return false;
  if (silent) return true;
  state.env.references ??= {};
  state.env.references[label] ??= { title, href };
  const token = state.push("reference_definition", "", 0);
  token.map = [startLine, nextLine];
  token.hidden = true;
  token.meta = { label };
  state.line = nextLine;
  return true;
};

// ---- Container blocks
//
// A block quote and a list item each read a run of lines through Parseman's
// `lines()`. A line joins the run when its prefix matches (a quote's `>`, an
// item's indentation) or, failing that, lazily. The prefix checks read the line
// arrays, which hold the enclosing containers' narrowing, so every run reads the
// document itself rather than its parent's text. The run's body narrows the
// arrays over the run's lines and reads them as blocks; the run ends after the
// lines the blocks consumed.

/**
 * The container run being collected. Probes run line by line, each line's
 * prefix check first, and all of a run's probes finish before its body runs, so
 * one record per reader state serves every nesting depth.
 */
type Run = {
  start: number; endLine: number;
  /** The line the probes are on and its start in the source. */
  line: number; at: number;
  /** Where an item's marker ends on its first line. */
  firstEnd: number;
  /** The last quote line held nothing after its marker. */
  lastEmpty: boolean;
  /** The run ended at a line that starts another block. */
  terminated: boolean;
  /** Read the run's blocks, from `start` up to `end`. */
  read: (end: number) => void;
};

const anywhere = { firstSet: { kind: "any" as const }, canMatchNewline: false, isTrivia: false };

/** A prefix or lazy check: `test` returns where the line's prefix ends, or -1. */
function lineCheck(name: string, test: (state: StateBlock, line: number, pos: number) => number): Combinator<null> {
  const expected = [name];
  return {
    _tag: name, _meta: anywhere, _def: { tag: "unknown" },
    parse(_input: string, pos: number, ctx: ParseContext) {
      const state = ctx.state as StateBlock, run = state.run;
      if (pos !== run.at) { run.at = pos; run.line++; }
      const end = run.line < run.endLine ? test(state, run.line, pos) : -1;
      return end < 0 ? { ok: false, expected, span: { start: pos, end: pos } } : { ok: true, value: null, span: { start: pos, end } };
    },
  };
}

/** A run's body: the block reader over the run's lines. */
const runBody: Combinator<null> = {
  _tag: "container", _meta: { ...anywhere, canMatchNewline: true }, _def: { tag: "unknown" },
  parse(input: string, _pos: number, ctx: ParseContext) {
    const view = ctx.lineView!;
    // Nested runs read the document, so their columns count from its lines.
    ctx.lineView = undefined;
    const state = ctx.state as StateBlock;
    const { start, read } = state.run;
    read(start + view.lines.length);
    const consumed = state.line - start;
    return { ok: true, value: null, span: { start: 0, end: consumed < view.lines.length ? view.lines[consumed]!.offset : input.length } };
  },
};

/** Collect the run `grammar` opens at `start`, and read it with `read`. */
function readRun(state: StateBlock, grammar: Combinator<null>, start: number, endLine: number, firstEnd: number, read: (end: number) => void): void {
  const run = state.run;
  run.start = start; run.line = start - 1; run.at = -1; run.endLine = endLine; run.firstEnd = firstEnd;
  run.lastEmpty = false; run.terminated = false; run.read = read;
  const lineStart = state.src.lastIndexOf("\n", state.bMarks[start]! - 1) + 1;
  if (!grammar.parse(state.src, lineStart, state.context ??= { trackLines: false, state }).ok) throw new Error("a container run did not open");
}

const quoteLine = (state: StateBlock, line: number) =>
  state.src.charCodeAt(state.bMarks[line]! + state.tShift[line]!) === 0x3e && state.sCount[line]! >= state.blkIndent;

// A quote line: `>` after any indentation, on a line the enclosing block reaches.
const quotePrefix = lineCheck("blockquote marker", (state, line) => {
  const pos = state.bMarks[line]! + state.tShift[line]!, max = state.eMarks[line]!;
  if (pos >= max || !quoteLine(state, line)) return -1;
  state.run.lastEmpty = state.skipSpaces(pos + 1) >= max;
  return pos + 1;
});
// A lazy quote line continues a paragraph: it follows a quote line with content,
// and starts no block that ends the quote.
const quoteLazy = lineCheck("lazy continuation", (state, line, pos) => {
  if (state.isEmpty(line) || state.run.lastEmpty) return -1;
  if (terminates(state.md.block.ruler.getRules("blockquote"), state, line, state.run.endLine)) { state.run.terminated = true; return -1; }
  return pos;
});
const quote = lines(quotePrefix, runBody, { lazy: quoteLazy });

// An item's first line ends at its marker; later lines belong when blank or
// indented to the item's content.
const itemFirst = lineCheck("list marker", state => state.run.firstEnd);
const itemPrefix = lineCheck("list item indentation", (state, line, pos) => state.isEmpty(line) || state.sCount[line]! >= state.blkIndent ? pos : -1);
// A line a paragraph in the item may continue onto: it follows a line with
// content and is no marker that ends the item's paragraphs.
const itemLazy = lineCheck("lazy continuation", (state, line, pos) => {
  if (state.isEmpty(line - 1)) return -1;
  const marker = skipBulletListMarker(state, line) >= 0 || skipOrderedListMarker(state, line) >= 0;
  return marker && state.sCount[line]! - state.listIndent < 4 ? -1 : pos;
});
const item = lines(itemPrefix, runBody, { first: itemFirst, lazy: itemLazy });
// A description's first line ends at its marker; later lines belong when blank
// or indented past the marker. No line joins lazily.
const description = lines(itemPrefix, runBody, { first: itemFirst });

/** Read a list item's blocks: the run of lines from `line`, whose marker ends at `markerEnd`. */
export function readItem(state: StateBlock, line: number, endLine: number, markerEnd: number, empty: boolean): void {
  readRun(state, item, line, endLine, markerEnd, end => {
    // An item that starts with two blank lines is empty.
    if (empty && state.isEmpty(line + 1)) state.line = Math.min(state.line + 2, end);
    else state.md.block.tokenize(state, line, end);
  });
}

const blockquote: BlockRule = (state, startLine, endLine, silent) => {
  if (state.sCount[startLine]! - state.blkIndent >= 4 || state.src.charCodeAt(state.bMarks[startLine]! + state.tShift[startLine]!) !== 0x3e) return false;
  if (silent) return true;
  const oldLineMax = state.lineMax;
  const oldParentType = state.parentType;
  state.parentType = "blockquote";
  readRun(state, quote, startLine, endLine, 0, nextLine => {
    const oldBMarks: number[] = [], oldBSCount: number[] = [], oldSCount: number[] = [], oldTShift: number[] = [];
    const save = (line: number) => { oldBMarks.push(state.bMarks[line]!); oldBSCount.push(state.bsCount[line]!); oldTShift.push(state.tShift[line]!); oldSCount.push(state.sCount[line]!); };
    const terminated = state.run.terminated;
    for (let line = startLine; line < nextLine; line++) {
      // A lazy continuation line: a paragraph inside may continue onto it.
      if (!quoteLine(state, line)) { save(line); state.sCount[line] = -1; continue; }
      let pos = state.bMarks[line]! + state.tShift[line]! + 1;
      const max = state.eMarks[line]!;
      // The marker and one following space, or one column of a following tab, open the quote's line.
      let initial = state.sCount[line]! + 1;
      let spaceAfterMarker: boolean, adjustTab = false;
      if (state.src.charCodeAt(pos) === 0x20) { pos++; initial++; spaceAfterMarker = true; }
      else if (state.src.charCodeAt(pos) === 0x09) {
        spaceAfterMarker = true;
        if ((state.bsCount[line]! + initial) % 4 === 3) { pos++; initial++; } else adjustTab = true;
      } else spaceAfterMarker = false;
      let offset = initial;
      oldBMarks.push(state.bMarks[line]!);
      state.bMarks[line] = pos;
      while (pos < max) {
        const code = state.src.charCodeAt(pos);
        if (!isSpace(code)) break;
        offset += code === 0x09 ? 4 - (offset + state.bsCount[line]! + (adjustTab ? 1 : 0)) % 4 : 1;
        pos++;
      }
      oldBSCount.push(state.bsCount[line]!);
      state.bsCount[line] = state.sCount[line]! + 1 + (spaceAfterMarker ? 1 : 0);
      oldSCount.push(state.sCount[line]!);
      state.sCount[line] = offset - initial;
      oldTShift.push(state.tShift[line]!);
      state.tShift[line] = pos - state.bMarks[line]!;
    }
    if (terminated) {
      // A terminated quote ends here even for a paragraph's continuation lines.
      state.lineMax = nextLine;
      if (state.blkIndent !== 0) { save(nextLine); state.sCount[nextLine]! -= state.blkIndent; }
    }
    const oldIndent = state.blkIndent;
    state.blkIndent = 0;
    const open = state.push("blockquote_open", "blockquote", 1);
    open.markup = ">";
    const map: [number, number] = [startLine, 0];
    open.map = map;
    state.md.block.tokenize(state, startLine, nextLine);
    state.push("blockquote_close", "blockquote", -1).markup = ">";
    state.lineMax = oldLineMax;
    map[1] = state.line;
    for (let i = 0; i < oldTShift.length; i++) {
      state.bMarks[i + startLine] = oldBMarks[i]!; state.tShift[i + startLine] = oldTShift[i]!;
      state.sCount[i + startLine] = oldSCount[i]!; state.bsCount[i + startLine] = oldBSCount[i]!;
    }
    state.blkIndent = oldIndent;
  });
  state.parentType = oldParentType;
  return true;
};

/** The position after a bullet marker on `line`, or -1. */
export function skipBulletListMarker(state: StateBlock, line: number): number {
  const end = reach(bulletMarker, state.src, state.bMarks[line]! + state.tShift[line]!);
  return end <= state.eMarks[line]! ? end : -1;
}
/** The position after an ordered marker on `line`, or -1. */
export function skipOrderedListMarker(state: StateBlock, line: number): number {
  const end = reach(orderedMarker, state.src, state.bMarks[line]! + state.tShift[line]!);
  return end <= state.eMarks[line]! ? end : -1;
}
function markTightParagraphs(state: StateBlock, index: number): void {
  const level = state.level + 2;
  for (let i = index + 2, l = state.tokens.length - 2; i < l; i++) if (state.tokens[i]!.level === level && state.tokens[i]!.type === "paragraph_open") {
    state.tokens[i + 2]!.hidden = true; state.tokens[i]!.hidden = true; i += 2;
  }
}
const list: BlockRule = (state, startLine, endLine, silent) => {
  let nextLine = startLine, tight = true, start = 0;
  if (state.sCount[nextLine]! - state.blkIndent >= 4) return false;
  // A list item's continuation indented four past the enclosing list's indent is code.
  if (state.listIndent >= 0 && state.sCount[nextLine]! - state.listIndent >= 4 && state.sCount[nextLine]! < state.blkIndent) return false;
  const terminatingParagraph = silent && state.parentType === "paragraph" && state.sCount[nextLine]! >= state.blkIndent;
  let ordered: boolean, markerValue = 0, posAfterMarker: number;
  if ((posAfterMarker = skipOrderedListMarker(state, nextLine)) >= 0) {
    ordered = true;
    start = state.bMarks[nextLine]! + state.tShift[nextLine]!;
    markerValue = Number(state.src.slice(start, posAfterMarker - 1));
    // Only a list starting at 1 interrupts a paragraph.
    if (terminatingParagraph && markerValue !== 1) return false;
  } else if ((posAfterMarker = skipBulletListMarker(state, nextLine)) >= 0) ordered = false;
  else return false;
  // An empty item cannot interrupt a paragraph.
  if (terminatingParagraph && state.skipSpaces(posAfterMarker) >= state.eMarks[nextLine]!) return false;
  if (silent) return true;
  const markerCharCode = state.src.charCodeAt(posAfterMarker - 1);
  const listIndex = state.tokens.length;
  let token: Token;
  if (ordered) { token = state.push("ordered_list_open", "ol", 1); if (markerValue !== 1) token.attrs = [["start", markerValue]]; }
  else token = state.push("bullet_list_open", "ul", 1);
  const listLines: [number, number] = [nextLine, 0];
  token.map = listLines;
  token.markup = String.fromCharCode(markerCharCode);
  let prevEmptyEnd = false;
  const terminators = state.md.block.ruler.getRules("list");
  const oldParentType = state.parentType;
  state.parentType = "list";
  while (nextLine < endLine) {
    let pos = posAfterMarker;
    const max = state.eMarks[nextLine]!;
    const initial = state.sCount[nextLine]! + posAfterMarker - (state.bMarks[nextLine]! + state.tShift[nextLine]!);
    let offset = initial;
    while (pos < max) {
      const code = state.src.charCodeAt(pos);
      if (code === 0x09) offset += 4 - (offset + state.bsCount[nextLine]!) % 4;
      else if (code === 0x20) offset++;
      else break;
      pos++;
    }
    const contentStart = pos;
    // Content indented five or more past the marker is indented code: the item's indent is one past the marker.
    let indentAfterMarker = contentStart >= max ? 1 : offset - initial;
    if (indentAfterMarker > 4) indentAfterMarker = 1;
    const indent = initial + indentAfterMarker;
    token = state.push("list_item_open", "li", 1);
    token.markup = String.fromCharCode(markerCharCode);
    const itemLines: [number, number] = [nextLine, 0];
    token.map = itemLines;
    if (ordered) token.info = state.src.slice(start, posAfterMarker - 1);
    const oldTight = state.tight, oldTShift = state.tShift[nextLine]!, oldSCount = state.sCount[nextLine]!, oldListIndent = state.listIndent;
    state.listIndent = state.blkIndent;
    state.blkIndent = indent;
    state.tight = true;
    state.tShift[nextLine] = contentStart - state.bMarks[nextLine]!;
    state.sCount[nextLine] = offset;
    // An item that starts with two blank lines is empty.
    readItem(state, nextLine, endLine, posAfterMarker, contentStart >= max);
    if (!state.tight || prevEmptyEnd) tight = false;
    prevEmptyEnd = state.line - nextLine > 1 && state.isEmpty(state.line - 1);
    state.blkIndent = state.listIndent;
    state.listIndent = oldListIndent;
    state.tShift[nextLine] = oldTShift;
    state.sCount[nextLine] = oldSCount;
    state.tight = oldTight;
    state.push("list_item_close", "li", -1).markup = String.fromCharCode(markerCharCode);
    nextLine = state.line;
    itemLines[1] = nextLine;
    if (nextLine >= endLine || state.sCount[nextLine]! < state.blkIndent || state.sCount[nextLine]! - state.blkIndent >= 4) break;
    if (terminates(terminators, state, nextLine, endLine)) break;
    if (ordered) {
      posAfterMarker = skipOrderedListMarker(state, nextLine);
      if (posAfterMarker < 0) break;
      start = state.bMarks[nextLine]! + state.tShift[nextLine]!;
    } else {
      posAfterMarker = skipBulletListMarker(state, nextLine);
      if (posAfterMarker < 0) break;
    }
    // A different marker starts a new list.
    if (markerCharCode !== state.src.charCodeAt(posAfterMarker - 1)) break;
  }
  state.push(ordered ? "ordered_list_close" : "bullet_list_close", ordered ? "ol" : "ul", -1).markup = String.fromCharCode(markerCharCode);
  listLines[1] = nextLine;
  state.line = nextLine;
  state.parentType = oldParentType;
  if (tight) markTightParagraphs(state, listIndex);
  return true;
};

// ---- Definition lists
//
// A term is a paragraph's first line whose next line is a marker line: `:`
// then a space, a tab or the line end, after any block-relative indentation.
// The rule runs after every other block start, so a line that starts another
// block is never a term, and a marker line never interrupts a paragraph, so
// only a paragraph's first line is one. Each description reads a run of lines
// as a relative list item does, without lazy continuation. A description's run
// takes the blank lines after it, so when a term follows a list after any
// blank lines, the list's close is the last token, and the term reopens it.

/** Where a marker line's `:` ends, or -1. */
function markerEnd(state: StateBlock, line: number, endLine: number): number {
  if (line >= endLine || state.sCount[line]! < state.blkIndent) return -1;
  return reach(definitionMarker, state.src, state.bMarks[line]! + state.tShift[line]!);
}
const leadOf = (state: StateBlock, line: number) => state.src.slice(state.bMarks[line]!, state.bMarks[line]! + state.tShift[line]!);
const lastContent = (state: StateBlock, from: number, end: number) => { while (end > from + 1 && state.isEmpty(end - 1)) end--; return end; };

/**
 * Read the description whose marker on `line` ends at `after`. Returns the
 * description in the preferred form, `: ` and two-space continuation, or
 * undefined when its first line is empty but later lines are not.
 */
function readDescription(state: StateBlock, line: number, endLine: number, after: number): string | undefined {
  const max = state.eMarks[line]!;
  let offset = state.sCount[line]! + 1, pos = after;
  for (; pos < max; pos++) {
    const code = state.src.charCodeAt(pos);
    if (code === 0x09) offset += 4 - (offset + state.bsCount[line]!) % 4;
    else if (code === 0x20) offset++;
    else break;
  }
  const open = state.push("dd_open", "dd", 1);
  const map: [number, number] = [line, 0];
  open.map = map;
  const lead = leadOf(state, line);
  const saved = { blkIndent: state.blkIndent, tight: state.tight, bMark: state.bMarks[line]!, tShift: state.tShift[line]!, sCount: state.sCount[line]! };
  // Every line indented past the marker belongs, as in a relative list item;
  // the first line starts at its content.
  state.blkIndent = saved.sCount + 1;
  state.bMarks[line] = pos; state.tShift[line] = 0; state.sCount[line] = offset;
  state.tight = true;
  readRun(state, description, line, endLine, after, end => state.md.block.tokenize(state, line, end));
  const tight = state.tight;
  state.blkIndent = saved.blkIndent; state.tight = saved.tight;
  state.bMarks[line] = saved.bMark; state.tShift[line] = saved.tShift; state.sCount[line] = saved.sCount;
  let mixed = false;
  for (let index = line + 1; index < state.line; index++) {
    const own = leadOf(state, index);
    if (!state.isEmpty(index) && !own.startsWith(lead) && !lead.startsWith(own)) mixed = true;
  }
  if (!tight || mixed) open.meta = { ...(tight ? {} : { loose: true }), ...(mixed ? { mixed: true } : {}) };
  state.push("dd_close", "dd", -1);
  map[1] = state.line;
  const first = state.src.slice(pos, max), rest = state.getLines(line + 1, lastContent(state, line, state.line), offset, false);
  if (!first) return rest ? undefined : ":";
  return `: ${rest ? `${first}\n${rest}`.replace(/\n(?=[^\n])/g, "\n  ") : first}`;
}

/**
 * The authored source of a list's groups, and whether every group so far is
 * in the preferred form: a term, its descriptions on the following lines, and
 * one blank line before each later term.
 */
interface ListSource { column: number; chunks: string[]; preferred: boolean; last: number }
const definitionList: BlockRule = (state, startLine, endLine, silent) => {
  if (silent || markerEnd(state, startLine + 1, endLine) < 0) return false;
  const last = state.tokens.at(-1);
  let map: [number, number], source: ListSource;
  if (last?.type === "dl_close" && last.level === state.level) {
    state.tokens.pop(); state.level++;
    map = last.map!; source = last.meta as unknown as ListSource;
  } else {
    map = [startLine, 0];
    source = { column: state.sCount[startLine]!, chunks: [], preferred: true, last: startLine };
    state.push("dl_open", "dl", 1).map = map;
  }
  state.push("dt_open", "dt", 1).map = [startLine, startLine + 1];
  const inline = state.push("inline", "", 0);
  const term = asciiTrim(state.lineText(startLine));
  inline.content = term; inline.map = [startLine, startLine + 1]; inline.children = [];
  state.push("dt_close", "dt", -1);
  let line = startLine + 1, preferred: string | undefined = term;
  for (let after: number; (after = markerEnd(state, line, endLine)) >= 0; line = state.line) {
    const written = readDescription(state, line, endLine, after);
    preferred = preferred === undefined || written === undefined ? undefined : `${preferred}\n${written}`;
  }
  const end = lastContent(state, startLine, line);
  const from = source.chunks.length ? source.last : startLine;
  const chunk = state.getLines(from, end, source.column, false);
  source.chunks.push(chunk);
  source.preferred &&= preferred !== undefined && chunk === (source.chunks.length > 1 ? `\n${preferred}` : preferred);
  source.last = end;
  const close = state.push("dl_close", "dl", -1);
  close.map = map; close.meta = source as unknown as Record<string, unknown>;
  map[1] = state.line = line;
  return true;
};

export class ParserBlock {
  ruler = new Ruler<BlockRule>();
  constructor() {
    const rules: [string, BlockRule, string[]?][] = [
      ["table", table, ["paragraph", "reference"]],
      ["code", code],
      ["fence", fence, ["paragraph", "reference", "blockquote", "list"]],
      ["blockquote", blockquote, ["paragraph", "reference", "blockquote", "list"]],
      ["hr", hr, ["paragraph", "reference", "blockquote", "list"]],
      ["list", list, ["paragraph", "reference", "blockquote"]],
      ["reference", reference],
      ["html_block", html_block, ["paragraph", "reference", "blockquote"]],
      ["heading", heading, ["paragraph", "reference", "blockquote"]],
      ["lheading", lheading],
      ["definition_list", definitionList],
      ["paragraph", paragraph],
    ];
    for (const [name, fn, alt] of rules) this.ruler.push(name, fn, { alt: alt ?? [] });
  }
  tokenize(state: StateBlock, startLine: number, endLine: number): void {
    const rules = this.ruler.getRules("");
    const maxNesting = state.md.options.maxNesting;
    // `before`: whether blank lines came before the current block began.
    let line = startLine, hasEmptyLines = false, before = false;
    while (line < endLine) {
      state.line = line = state.skipEmptyLines(line);
      if (line >= endLine || state.sCount[line]! < state.blkIndent) break;
      if (state.stop !== undefined && state.level === 0 && state.stop(line)) break;
      // Deep nesting reads the rest as nothing rather than overflowing the stack.
      if (state.level >= maxNesting) { state.line = endLine; break; }
      const prevLine = state.line;
      let ok = false;
      for (const rule of rules) {
        ok = rule(state, line, endLine, false);
        if (ok) { if (prevLine >= state.line) throw new Error("block rule didn't increment state.line"); break; }
      }
      if (!ok) throw new Error("none of the block rules matched");
      // A block followed by a blank line loosens its list. A term that
      // continues the definition list before it adds to that block, so the
      // blank lines between its groups loosen nothing.
      const last = state.tokens[state.tokens.length - 1];
      if (last?.type !== "dl_close" || last.map![0] >= line) before = hasEmptyLines;
      state.tight = !before;
      hasEmptyLines = before || state.isEmpty(state.line - 1);
      line = state.line;
      if (line < endLine && state.isEmpty(line)) { hasEmptyLines = true; state.line = ++line; }
    }
  }
  parse(src: string, md: Engine, env: Env, tokens: Token[], stop?: (line: number) => boolean): void {
    if (!src) return;
    const state = new StateBlock(src, md, env, tokens);
    state.stop = stop;
    this.tokenize(state, state.line, state.lineMax);
  }
}
