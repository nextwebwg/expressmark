// The inline reader. At each position the rules ask the lexicon which
// construct starts there; delimiter runs are paired afterwards by CommonMark's
// emphasis algorithm. The behavior follows markdown-it 15.0.3; see the notice in engine.ts.
import { decodeHTMLStrict } from "entities";
import { Ruler } from "./ruler.js";
import { Token } from "./token.js";
import { fromCodePoint, isMdAsciiPunct, isPunctCharCode, isSpace, isValidEntityCode, isWhiteSpace, normalizeReference } from "./utils.js";
import { autolink as autolinkGrammar, entity as entityGrammar, htmlTag, match, reach, textRun } from "./lexicon.js";
import { parseLinkDestination, parseLinkLabel, parseLinkTitle } from "./links.js";
import type { Engine } from "./engine.js";
import type { Env } from "./block.js";

export type InlineRule = (state: StateInline, silent: boolean) => boolean;
export type PostRule = (state: StateInline) => void;
export interface Delimiter { marker: number; length: number; token: number; end: number; open: boolean; close: boolean }

export class StateInline {
  src: string;
  env: Env;
  md: Engine;
  tokens: Token[];
  tokens_meta: ({ delimiters: Delimiter[] } | undefined)[];
  pos = 0;
  posMax: number;
  level = 0;
  pending = "";
  pendingLevel = 0;
  /** Where each position's construct ends, when a label scan has read it. */
  cache = new Map<number, number>();
  delimiters: Delimiter[] = [];
  private previousDelimiters: Delimiter[][] = [];
  /** Where the last backtick run of each length starts, for finding code spans' ends. */
  backticks: Map<number, number> | undefined;
  /** An unterminated comment or declaration: no later one can end either. */
  skipHtmlSpecial = false;
  linkLevel = 0;
  constructor(src: string, md: Engine, env: Env, tokens: Token[]) {
    this.src = src; this.md = md; this.env = env; this.tokens = tokens;
    this.tokens_meta = Array.from({ length: tokens.length }, () => undefined);
    this.posMax = src.length;
  }
  pushPending(): Token {
    const token = new Token("text", "", 0);
    token.content = this.pending; token.level = this.pendingLevel;
    this.tokens.push(token);
    this.pending = "";
    return token;
  }
  push(type: string, tag: string, nesting: -1 | 0 | 1): Token {
    if (this.pending) this.pushPending();
    const token = new Token(type, tag, nesting);
    let meta: { delimiters: Delimiter[] } | undefined;
    if (nesting < 0) { this.level--; this.delimiters = this.previousDelimiters.pop()!; }
    token.level = this.level;
    // An opening token starts its own delimiter scope, as link text does.
    if (nesting > 0) { this.level++; this.previousDelimiters.push(this.delimiters); this.delimiters = []; meta = { delimiters: this.delimiters }; }
    this.pendingLevel = this.level;
    this.tokens.push(token);
    this.tokens_meta.push(meta);
    return token;
  }
  /** Whether the delimiter run at `start` can open or close emphasis, and its length. */
  scanDelims(start: number, canSplitWord: boolean): { can_open: boolean; can_close: boolean; length: number } {
    const max = this.posMax, marker = this.src.charCodeAt(start);
    let lastChar: number;
    if (start === 0) lastChar = 0x20;
    else if (start === 1) { lastChar = this.src.charCodeAt(0); if ((lastChar & 0xf800) === 0xd800) lastChar = 0xfffd; }
    else {
      lastChar = this.src.charCodeAt(start - 1);
      if ((lastChar & 0xfc00) === 0xdc00) {
        const high = this.src.charCodeAt(start - 2);
        lastChar = (high & 0xfc00) === 0xd800 ? 0x10000 + (high - 0xd800 << 10) + (lastChar - 0xdc00) : 0xfffd;
      } else if ((lastChar & 0xfc00) === 0xd800) lastChar = 0xfffd;
    }
    let pos = start;
    while (pos < max && this.src.charCodeAt(pos) === marker) pos++;
    const count = pos - start;
    let nextChar = pos < max ? this.src.charCodeAt(pos) : 0x20;
    if ((nextChar & 0xfc00) === 0xd800) {
      const low = this.src.charCodeAt(pos + 1);
      nextChar = (low & 0xfc00) === 0xdc00 ? 0x10000 + (nextChar - 0xd800 << 10) + (low - 0xdc00) : 0xfffd;
    } else if ((nextChar & 0xfc00) === 0xdc00) nextChar = 0xfffd;
    const lastPunct = isMdAsciiPunct(lastChar) || isPunctCharCode(lastChar), nextPunct = isMdAsciiPunct(nextChar) || isPunctCharCode(nextChar);
    const lastWhite = isWhiteSpace(lastChar), nextWhite = isWhiteSpace(nextChar);
    const leftFlanking = !nextWhite && (!nextPunct || lastWhite || lastPunct);
    const rightFlanking = !lastWhite && (!lastPunct || nextWhite || nextPunct);
    return {
      can_open: leftFlanking && (canSplitWord || !rightFlanking || lastPunct),
      can_close: rightFlanking && (canSplitWord || !leftFlanking || nextPunct),
      length: count,
    };
  }
}

// ---- Tokenizing rules

const text: InlineRule = (state, silent) => {
  const end = reach(textRun, state.src, state.pos);
  if (end < 0) return false;
  const stop = Math.min(end, state.posMax);
  if (!silent) state.pending += state.src.slice(state.pos, stop);
  state.pos = stop;
  return true;
};

const isSchemeChar = (code: number) => code >= 0x41 && code <= 0x5a || code >= 0x61 && code <= 0x7a || code >= 0x30 && code <= 0x39 || code === 0x2b || code === 0x2d || code === 0x2e;
// A URL with a scheme, found at its `://` and read back over the scheme in pending text.
const linkify: InlineRule = (state, silent) => {
  if (!state.md.options.linkify || state.linkLevel > 0) return false;
  const pos = state.pos, max = state.posMax;
  if (pos + 3 > max || state.src.charCodeAt(pos) !== 0x3a || state.src.charCodeAt(pos + 1) !== 0x2f || state.src.charCodeAt(pos + 2) !== 0x2f) return false;
  const protoMin = pos - Math.min(10, state.pending.length, pos);
  let protoStart = pos;
  while (protoStart > protoMin && isSchemeChar(state.src.charCodeAt(protoStart - 1))) protoStart--;
  const first = state.src.charCodeAt(protoStart);
  if (protoStart === pos || !(first >= 0x41 && first <= 0x5a || first >= 0x61 && first <= 0x7a)) return false;
  const protoLength = pos - protoStart;
  const link = state.md.linkify.matchAtStart(state.src.slice(protoStart));
  if (!link) return false;
  let url = link.url;
  if (url.length <= protoLength) return false;
  // A `*` closing the URL belongs to emphasis.
  url = url.replace(/\*+$/, "");
  const fullUrl = state.md.normalizeLink(url);
  if (!state.md.validateLink(fullUrl)) return false;
  if (!silent) {
    state.pending = state.pending.slice(0, -protoLength);
    const open = state.push("link_open", "a", 1);
    open.attrs = [["href", fullUrl]]; open.markup = "linkify"; open.info = "auto";
    state.push("text", "", 0).content = state.md.normalizeLinkText(url);
    const close = state.push("link_close", "a", -1);
    close.markup = "linkify"; close.info = "auto";
  }
  state.pos += url.length - protoLength;
  return true;
};

const newline: InlineRule = (state, silent) => {
  let pos = state.pos;
  if (state.src.charCodeAt(pos) !== 0x0a) return false;
  const last = state.pending.length - 1, max = state.posMax;
  if (!silent) {
    // Two trailing spaces make a hard break; one is trimmed.
    if (last >= 0 && state.pending.charCodeAt(last) === 0x20) {
      if (last >= 1 && state.pending.charCodeAt(last - 1) === 0x20) {
        let ws = last - 1;
        while (ws >= 1 && state.pending.charCodeAt(ws - 1) === 0x20) ws--;
        state.pending = state.pending.slice(0, ws);
        state.push("hardbreak", "br", 0);
      } else { state.pending = state.pending.slice(0, -1); state.push("softbreak", "br", 0); }
    } else state.push("softbreak", "br", 0);
  }
  pos++;
  while (pos < max && isSpace(state.src.charCodeAt(pos))) pos++;
  state.pos = pos;
  return true;
};

const ESCAPABLE = new Set("\\!\"#$%&'()*+,./:;<=>?@[]^_`{|}~-");
const escape: InlineRule = (state, silent) => {
  let pos = state.pos;
  const max = state.posMax;
  if (state.src.charCodeAt(pos) !== 0x5c || ++pos >= max) return false;
  let code = state.src.charCodeAt(pos);
  if (code === 0x0a) {
    if (!silent) state.push("hardbreak", "br", 0);
    pos++;
    while (pos < max && isSpace(state.src.charCodeAt(pos))) pos++;
    state.pos = pos;
    return true;
  }
  if (code === 0x20) {
    if (!silent) { const token = state.push("text_special", "", 0); token.content = "\\"; token.markup = "\\"; token.info = "escape"; }
    state.pos = pos;
    return true;
  }
  let escaped = state.src[pos]!;
  if (code >= 0xd800 && code <= 0xdbff && pos + 1 < max) {
    code = state.src.charCodeAt(pos + 1);
    if (code >= 0xdc00 && code <= 0xdfff) { escaped += state.src[pos + 1]; pos++; }
  }
  if (!silent) {
    const token = state.push("text_special", "", 0);
    token.content = ESCAPABLE.has(escaped) ? escaped : `\\${escaped}`;
    token.markup = `\\${escaped}`; token.info = "escape";
  }
  state.pos = pos + 1;
  return true;
};

const backtick: InlineRule = (state, silent) => {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x60) return false;
  const max = state.posMax;
  let pos = start + 1;
  while (pos < max && state.src.charCodeAt(pos) === 0x60) pos++;
  const marker = state.src.slice(start, pos), openerLength = marker.length;
  if (!state.backticks) {
    // The last run of each length: a span with no later closer of its length never closes.
    state.backticks = new Map();
    for (let at = state.src.indexOf("`"); at !== -1; at = state.src.indexOf("`", at)) {
      const runStart = at;
      while (state.src.charCodeAt(++at) === 0x60);
      state.backticks.set(at - runStart, runStart);
    }
  }
  if ((state.backticks.get(openerLength) ?? -1) >= pos) {
    let matchEnd = pos, matchStart: number;
    while ((matchStart = state.src.indexOf("`", matchEnd)) !== -1 && matchStart < max) {
      matchEnd = matchStart + 1;
      while (state.src.charCodeAt(matchEnd) === 0x60) matchEnd++;
      if (matchEnd > max) break;
      if (matchEnd - matchStart === openerLength) {
        if (!silent) {
          const token = state.push("code_inline", "code", 0);
          token.markup = marker;
          let content = state.src.slice(pos, matchStart).replace(/\n/g, " ");
          if (content.startsWith(" ") && content.endsWith(" ") && /[^ ]/.test(content)) content = content.slice(1, -1);
          token.content = content;
        }
        state.pos = matchEnd;
        return true;
      }
    }
  }
  if (!silent) state.pending += marker;
  state.pos = pos;
  return true;
};

const strikethrough: InlineRule = (state, silent) => {
  const marker = state.src.charCodeAt(state.pos);
  if (silent || marker !== 0x7e) return false;
  const scanned = state.scanDelims(state.pos, true);
  let length = scanned.length;
  if (length < 2) return false;
  if (length % 2) { state.push("text", "", 0).content = "~"; length--; }
  for (let i = 0; i < length; i += 2) {
    state.push("text", "", 0).content = "~~";
    state.delimiters.push({ marker, length: 0, token: state.tokens.length - 1, end: -1, open: scanned.can_open, close: scanned.can_close });
  }
  state.pos += scanned.length;
  return true;
};

const emphasis: InlineRule = (state, silent) => {
  const marker = state.src.charCodeAt(state.pos);
  if (silent || marker !== 0x5f && marker !== 0x2a) return false;
  const scanned = state.scanDelims(state.pos, marker === 0x2a);
  for (let i = 0; i < scanned.length; i++) {
    state.push("text", "", 0).content = String.fromCharCode(marker);
    state.delimiters.push({ marker, length: scanned.length, token: state.tokens.length - 1, end: -1, open: scanned.can_open, close: scanned.can_close });
  }
  state.pos += scanned.length;
  return true;
};

const skipLinkSpace = (state: StateInline, pos: number): number => {
  for (; pos < state.posMax; pos++) { const code = state.src.charCodeAt(pos); if (!isSpace(code) && code !== 0x0a) break; }
  return pos;
};
/** A full or collapsed reference label after a link's text, or the text itself. */
function referenceLabel(state: StateInline, pos: number, labelStart: number, labelEnd: number): { label: string; pos: number } {
  let label: string | undefined;
  if (pos < state.posMax && state.src.charCodeAt(pos) === 0x5b) {
    const start = pos + 1;
    pos = parseLinkLabel(state, pos);
    if (pos >= 0) label = state.src.slice(start, pos++);
    else pos = labelEnd + 1;
  } else pos = labelEnd + 1;
  return { label: label || state.src.slice(labelStart, labelEnd), pos };
}

const link: InlineRule = (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x5b) return false;
  const oldPos = state.pos, max = state.posMax, labelStart = state.pos + 1;
  const labelEnd = parseLinkLabel(state, state.pos, true);
  if (labelEnd < 0) return false;
  let pos = labelEnd + 1, href = "", title = "", label: string | undefined, parseReference = true;
  if (pos < max && state.src.charCodeAt(pos) === 0x28) {
    // An inline target; one that does not close falls back to a reference.
    parseReference = false;
    pos = skipLinkSpace(state, pos + 1);
    if (pos >= max) return false;
    const destination = parseLinkDestination(state.src, pos, state.posMax);
    if (destination.ok) {
      href = state.md.normalizeLink(destination.str);
      if (state.md.validateLink(href)) pos = destination.pos; else href = "";
      const start = pos;
      pos = skipLinkSpace(state, pos);
      const parsed = parseLinkTitle(state.src, pos, state.posMax);
      if (pos < max && start !== pos && parsed.ok) { title = parsed.str; pos = skipLinkSpace(state, parsed.pos); }
    }
    if (pos >= max || state.src.charCodeAt(pos) !== 0x29) parseReference = true;
    pos++;
  }
  if (parseReference) {
    if (state.env.references === undefined) return false;
    const reference = referenceLabel(state, pos, labelStart, labelEnd);
    pos = reference.pos;
    label = normalizeReference(reference.label);
    const found = state.env.references[label];
    if (!found) { state.pos = oldPos; return false; }
    href = found.href; title = found.title;
  }
  if (!silent) {
    state.pos = labelStart; state.posMax = labelEnd;
    const open = state.push("link_open", "a", 1);
    open.attrs = [["href", href]];
    if (title) open.attrs.push(["title", title]);
    if (label) open.meta = { label };
    state.linkLevel++;
    state.md.inline.tokenize(state);
    state.linkLevel--;
    state.push("link_close", "a", -1);
  }
  state.pos = pos; state.posMax = max;
  return true;
};

const image: InlineRule = (state, silent) => {
  const oldPos = state.pos, max = state.posMax;
  if (state.src.charCodeAt(state.pos) !== 0x21 || state.src.charCodeAt(state.pos + 1) !== 0x5b) return false;
  const labelStart = state.pos + 2;
  const labelEnd = parseLinkLabel(state, state.pos + 1, false);
  if (labelEnd < 0) return false;
  let pos = labelEnd + 1, href = "", title = "", label: string | undefined;
  if (pos < max && state.src.charCodeAt(pos) === 0x28) {
    pos = skipLinkSpace(state, pos + 1);
    if (pos >= max) return false;
    const destination = parseLinkDestination(state.src, pos, state.posMax);
    if (destination.ok) {
      href = state.md.normalizeLink(destination.str);
      if (state.md.validateLink(href)) pos = destination.pos; else href = "";
    }
    const start = pos;
    pos = skipLinkSpace(state, pos);
    const parsed = parseLinkTitle(state.src, pos, state.posMax);
    if (pos < max && start !== pos && parsed.ok) { title = parsed.str; pos = skipLinkSpace(state, parsed.pos); }
    else title = "";
    if (pos >= max || state.src.charCodeAt(pos) !== 0x29) { state.pos = oldPos; return false; }
    pos++;
  } else {
    if (state.env.references === undefined) return false;
    const reference = referenceLabel(state, pos, labelStart, labelEnd);
    pos = reference.pos;
    label = normalizeReference(reference.label);
    const found = state.env.references[label];
    if (!found) { state.pos = oldPos; return false; }
    href = found.href; title = found.title;
  }
  if (!silent) {
    const content = state.src.slice(labelStart, labelEnd);
    const children: Token[] = [];
    state.md.inline.parse(content, state.md, state.env, children);
    const token = state.push("image", "img", 0);
    token.attrs = [["src", href], ["alt", ""]];
    token.children = children;
    token.content = content;
    if (title) token.attrs.push(["title", title]);
    if (label) token.meta = { label };
  }
  state.pos = pos; state.posMax = max;
  return true;
};

const autolink: InlineRule = (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x3c) return false;
  const found = match(autolinkGrammar, state.posMax < state.src.length ? state.src.slice(0, state.posMax) : state.src, state.pos);
  if (!found) return false;
  const fullUrl = state.md.normalizeLink(found.email ? `mailto:${found.address}` : found.address);
  if (!state.md.validateLink(fullUrl)) return false;
  if (!silent) {
    const open = state.push("link_open", "a", 1);
    open.attrs = [["href", fullUrl]]; open.markup = "autolink"; open.info = "auto";
    state.push("text", "", 0).content = state.md.normalizeLinkText(found.address);
    const close = state.push("link_close", "a", -1);
    close.markup = "autolink"; close.info = "auto";
  }
  state.pos += found.address.length + 2;
  return true;
};

const isLetter = (code: number) => { const lower = code | 0x20; return lower >= 0x61 && lower <= 0x7a; };
// Where a comment, CDATA section, processing instruction or declaration at `pos` ends, or -1.
function scanSpecial(state: StateInline, pos: number): number {
  const src = state.src;
  let start: number, terminator: string;
  if (src.startsWith("<!--", pos)) {
    if (src.startsWith(">", pos + 4)) return pos + 5;
    if (src.startsWith("->", pos + 4)) return pos + 6;
    start = pos + 4; terminator = "-->";
  } else if (src.startsWith("<![CDATA[", pos)) { start = pos + 9; terminator = "]]>"; }
  else if (src.charCodeAt(pos + 1) === 0x3f) { start = pos + 2; terminator = "?>"; }
  else if (isLetter(src.charCodeAt(pos + 2))) { start = pos + 3; terminator = ">"; }
  else return -1;
  if (state.skipHtmlSpecial) return -1;
  const end = src.indexOf(terminator, start);
  if (end < 0) { state.skipHtmlSpecial = true; return -1; }
  return end + terminator.length;
}
const html_inline: InlineRule = (state, silent) => {
  if (!state.md.options.html) return false;
  const pos = state.pos;
  if (state.src.charCodeAt(pos) !== 0x3c || pos + 2 >= state.posMax) return false;
  const code = state.src.charCodeAt(pos + 1);
  let end: number;
  if (code === 0x21 || code === 0x3f) end = scanSpecial(state, pos);
  else if (code === 0x2f || isLetter(code)) end = reach(htmlTag, state.src, pos);
  else return false;
  if (end < 0) return false;
  if (!silent) {
    const token = state.push("html_inline", "", 0);
    token.content = state.src.slice(pos, end);
    // Inside an HTML link, text is not linkified.
    if (/^<a[>\s]/i.test(token.content)) state.linkLevel++;
    if (/^<\/a\s*>/i.test(token.content)) state.linkLevel--;
  }
  state.pos = end;
  return true;
};

const entity: InlineRule = (state, silent) => {
  const pos = state.pos;
  if (state.src.charCodeAt(pos) !== 0x26 || pos + 1 >= state.posMax) return false;
  const found = match(entityGrammar, state.src, pos);
  if (!found) return false;
  const content = found.code === undefined ? decodeHTMLStrict(found.text) : fromCodePoint(isValidEntityCode(found.code) ? found.code : 0xfffd);
  // A name no entity has stays text.
  if (found.code === undefined && content === found.text) return false;
  const length = found.text.length;
  if (!silent) {
    const token = state.push("text_special", "", 0);
    token.content = content; token.markup = state.src.slice(pos, pos + length); token.info = "entity";
  }
  state.pos += length;
  return true;
};

// ---- Post-processing: pair delimiters, then turn pairs into tags.

function processDelimiters(delimiters: Delimiter[]): void {
  const openersBottom = new Map<number, number[]>();
  const max = delimiters.length;
  if (!max) return;
  let headerIdx = 0, lastTokenIdx = -2;
  const jumps: number[] = [];
  for (let closerIdx = 0; closerIdx < max; closerIdx++) {
    const closer = delimiters[closerIdx]!;
    jumps.push(0);
    // Markers of one run share a header; a run of different markers starts a new one.
    if (delimiters[headerIdx]!.marker !== closer.marker || lastTokenIdx !== closer.token - 1) headerIdx = closerIdx;
    lastTokenIdx = closer.token;
    closer.length = closer.length || 0;
    if (!closer.close) continue;
    let bottoms = openersBottom.get(closer.marker);
    if (!bottoms) openersBottom.set(closer.marker, bottoms = [-1, -1, -1, -1, -1, -1]);
    const minOpenerIdx = bottoms[(closer.open ? 3 : 0) + closer.length % 3]!;
    let openerIdx = headerIdx - jumps[headerIdx]! - 1;
    let newMinOpenerIdx = openerIdx;
    for (; openerIdx > minOpenerIdx; openerIdx -= jumps[openerIdx]! + 1) {
      const opener = delimiters[openerIdx]!;
      if (opener.marker !== closer.marker) continue;
      if (opener.open && opener.end < 0) {
        // The rule of three: a run that can both open and close pairs only with lengths not summing to a multiple of three.
        const isOddMatch = (opener.close || closer.open) && (opener.length + closer.length) % 3 === 0 && (opener.length % 3 !== 0 || closer.length % 3 !== 0);
        if (!isOddMatch) {
          const lastJump = openerIdx > 0 && !delimiters[openerIdx - 1]!.open ? jumps[openerIdx - 1]! + 1 : 0;
          jumps[closerIdx] = closerIdx - openerIdx + lastJump;
          jumps[openerIdx] = lastJump;
          closer.open = false; opener.end = closerIdx; opener.close = false;
          newMinOpenerIdx = -1; lastTokenIdx = -2;
          break;
        }
      }
    }
    if (newMinOpenerIdx !== -1) bottoms[(closer.open ? 3 : 0) + (closer.length || 0) % 3] = newMinOpenerIdx;
  }
}
const eachScope = (process: (state: StateInline, delimiters: Delimiter[]) => void): PostRule => state => {
  process(state, state.delimiters);
  for (const meta of state.tokens_meta) if (meta?.delimiters) process(state, meta.delimiters);
};
const balance_pairs = eachScope((_state, delimiters) => processDelimiters(delimiters));

const strikethroughPairs = eachScope((state, delimiters) => {
  const loneMarkers: number[] = [];
  for (const startDelim of delimiters) {
    if (startDelim.marker !== 0x7e || startDelim.end === -1) continue;
    const endDelim = delimiters[startDelim.end]!;
    Object.assign(state.tokens[startDelim.token]!, { type: "s_open", tag: "s", nesting: 1, markup: "~~", content: "" });
    Object.assign(state.tokens[endDelim.token]!, { type: "s_close", tag: "s", nesting: -1, markup: "~~", content: "" });
    const before = state.tokens[endDelim.token - 1]!;
    if (before.type === "text" && before.content === "~") loneMarkers.push(endDelim.token - 1);
  }
  // A lone `~` before a closing pair moves outside it: `~~~a~~~` is `~<s>a</s>~`.
  while (loneMarkers.length) {
    const i = loneMarkers.pop()!;
    let j = i + 1;
    while (j < state.tokens.length && state.tokens[j]!.type === "s_close") j++;
    j--;
    if (i !== j) { const token = state.tokens[j]!; state.tokens[j] = state.tokens[i]!; state.tokens[i] = token; }
  }
});

const emphasisPairs = eachScope((state, delimiters) => {
  for (let i = delimiters.length - 1; i >= 0; i--) {
    const startDelim = delimiters[i]!;
    if (startDelim.marker !== 0x5f && startDelim.marker !== 0x2a || startDelim.end === -1) continue;
    const endDelim = delimiters[startDelim.end]!;
    // Two adjacent pairs of one marker, nested, are strong emphasis.
    const isStrong = i > 0 && delimiters[i - 1]!.end === startDelim.end + 1 && delimiters[i - 1]!.marker === startDelim.marker
      && delimiters[i - 1]!.token === startDelim.token - 1 && delimiters[startDelim.end + 1]!.token === endDelim.token + 1;
    const ch = String.fromCharCode(startDelim.marker);
    const tag = isStrong ? "strong" : "em", markup = isStrong ? ch + ch : ch;
    Object.assign(state.tokens[startDelim.token]!, { type: `${tag}_open`, tag, nesting: 1, markup, content: "" });
    Object.assign(state.tokens[endDelim.token]!, { type: `${tag}_close`, tag, nesting: -1, markup, content: "" });
    if (isStrong) { state.tokens[delimiters[i - 1]!.token]!.content = ""; state.tokens[delimiters[startDelim.end + 1]!.token]!.content = ""; i--; }
  }
});

const fragments_join: PostRule = state => {
  let level = 0, last = 0, curr = 0;
  const tokens = state.tokens, max = tokens.length;
  for (; curr < max; curr++) {
    const token = tokens[curr]!;
    if (token.nesting < 0) level--;
    token.level = level;
    if (token.nesting > 0) level++;
    if (token.type === "text" && curr + 1 < max && tokens[curr + 1]!.type === "text") tokens[curr + 1]!.content = token.content + tokens[curr + 1]!.content;
    else { if (curr !== last) tokens[last] = token; last++; }
  }
  if (curr !== last) tokens.length = last;
};

export class ParserInline {
  ruler = new Ruler<InlineRule>();
  ruler2 = new Ruler<PostRule>();
  State = StateInline;
  constructor() {
    for (const [name, fn] of [["text", text], ["linkify", linkify], ["newline", newline], ["escape", escape], ["backticks", backtick], ["strikethrough", strikethrough],
      ["emphasis", emphasis], ["link", link], ["image", image], ["autolink", autolink], ["html_inline", html_inline], ["entity", entity]] as const) this.ruler.push(name, fn);
    for (const [name, fn] of [["balance_pairs", balance_pairs], ["strikethrough", strikethroughPairs], ["emphasis", emphasisPairs], ["fragments_join", fragments_join]] as const) this.ruler2.push(name, fn);
  }
  /** Advance past the construct at `state.pos` without producing tokens, as label scans do. */
  skipToken(state: StateInline): void {
    const pos = state.pos;
    const cached = state.cache.get(pos);
    if (cached !== undefined) { state.pos = cached; return; }
    let ok = false;
    if (state.level < state.md.options.maxNesting) {
      for (const rule of this.ruler.getRules("")) {
        state.level++;
        ok = rule(state, true);
        state.level--;
        if (ok) { if (pos >= state.pos) throw new Error("inline rule didn't increment state.pos"); break; }
      }
    } else state.pos = state.posMax;
    if (!ok) state.pos++;
    state.cache.set(pos, state.pos);
  }
  tokenize(state: StateInline): void {
    const rules = this.ruler.getRules("");
    const end = state.posMax, maxNesting = state.md.options.maxNesting;
    while (state.pos < end) {
      const prevPos = state.pos;
      let ok = false;
      if (state.level < maxNesting) for (const rule of rules) {
        ok = rule(state, false);
        if (ok) { if (prevPos >= state.pos) throw new Error("inline rule didn't increment state.pos"); break; }
      }
      if (ok) { if (state.pos >= end) break; continue; }
      state.pending += state.src[state.pos++];
    }
    if (state.pending) state.pushPending();
  }
  parse(src: string, md: Engine, env: Env, tokens: Token[]): void {
    const state = new this.State(src, md, env, tokens);
    this.tokenize(state);
    for (const rule of this.ruler2.getRules("")) rule(state);
  }
}
