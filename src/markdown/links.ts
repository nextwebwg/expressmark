// Link destinations, titles and labels, and the URL normalization links share.
import * as mdurl from "mdurl";
import punycode from "punycode.js";
import { angleDestination, match } from "./lexicon.js";
import { unescapeAll } from "./utils.js";
import type { StateInline } from "./inline.js";

export interface DestinationResult { ok: boolean; pos: number; str: string }
/** A link destination in `str` from `start`, read no further than `max`. */
export function parseLinkDestination(str: string, start: number, max: number): DestinationResult {
  const result: DestinationResult = { ok: false, pos: 0, str: "" };
  if (str.charCodeAt(start) === 0x3c) {
    const value = match(angleDestination, max < str.length ? str.slice(0, max) : str, start);
    if (value !== undefined) { result.pos = start + value.length + 2; result.str = unescapeAll(value); result.ok = true; }
    return result;
  }
  // An unbracketed destination ends at a space or control character, or at a
  // `)` that closes no `(` it opened; it may nest 32 parentheses.
  let pos = start, level = 0;
  while (pos < max) {
    const code = str.charCodeAt(pos);
    if (code <= 0x20 || code === 0x7f) break;
    if (code === 0x5c && pos + 1 < max) {
      // A backslash before a space escapes nothing; the space still ends the destination.
      pos += str.charCodeAt(pos + 1) === 0x20 ? 1 : 2;
      continue;
    }
    if (code === 0x28 && ++level > 32) return result;
    if (code === 0x29) { if (level === 0) break; level--; }
    pos++;
  }
  if (start === pos || level !== 0) return result;
  result.str = unescapeAll(str.slice(start, pos)); result.pos = pos; result.ok = true;
  return result;
}

export interface TitleResult { ok: boolean; can_continue: boolean; pos: number; str: string; marker: number }
/** A link title from `start`; `previous` continues a definition's title from the line before. */
export function parseLinkTitle(str: string, start: number, max: number, previous?: TitleResult): TitleResult {
  let pos = start;
  const state: TitleResult = { ok: false, can_continue: false, pos: 0, str: "", marker: 0 };
  if (previous) { state.str = previous.str; state.marker = previous.marker; }
  else {
    if (pos >= max) return state;
    let marker = str.charCodeAt(pos);
    if (marker !== 0x22 && marker !== 0x27 && marker !== 0x28) return state;
    start++; pos++;
    if (marker === 0x28) marker = 0x29;
    state.marker = marker;
  }
  while (pos < max) {
    const code = str.charCodeAt(pos);
    if (code === state.marker) { state.pos = pos + 1; state.str += unescapeAll(str.slice(start, pos)); state.ok = true; return state; }
    if (code === 0x28 && state.marker === 0x29) return state;
    if (code === 0x5c && pos + 1 < max) pos++;
    pos++;
  }
  state.can_continue = true;
  state.str += unescapeAll(str.slice(start, pos));
  return state;
}

/** Where the label opened at `start` ends, skipping whole inline constructs; -1 when it does not end. */
export function parseLinkLabel(state: StateInline, start: number, disableNested = false): number {
  const max = state.posMax, oldPos = state.pos;
  let level = 1, found = false;
  state.pos = start + 1;
  while (state.pos < max) {
    const marker = state.src.charCodeAt(state.pos);
    if (marker === 0x5d && --level === 0) { found = true; break; }
    const prevPos = state.pos;
    state.md.inline.skipToken(state);
    if (marker === 0x5b) {
      // A `[` read as plain text nests; one that opened a construct is a nested link.
      if (prevPos === state.pos - 1) level++;
      else if (disableNested) { state.pos = oldPos; return -1; }
    }
  }
  const labelEnd = found ? state.pos : -1;
  state.pos = oldPos;
  return labelEnd;
}

const BAD_PROTO_RE = /^(vbscript|javascript|file|data):/;
const GOOD_DATA_RE = /^data:image\/(gif|png|jpeg|webp);/;
/** Links never take script, file or non-image data URLs. */
export function validateLink(url: string): boolean {
  const text = url.trim().toLowerCase();
  return BAD_PROTO_RE.test(text) ? GOOD_DATA_RE.test(text) : true;
}
const RECODE_HOSTNAME_FOR = ["http:", "https:", "mailto:"];
/** A URL percent-encoded, with an international hostname in punycode. */
export function normalizeLink(url: string): string {
  const parsed = mdurl.parse(url, true);
  if (parsed.hostname && (!parsed.protocol || RECODE_HOSTNAME_FOR.includes(parsed.protocol))) {
    try { parsed.hostname = punycode.toASCII(parsed.hostname); } catch { /* keep the hostname as written */ }
  }
  for (const part of ["auth", "hostname", "pathname", "search", "hash"] as const) if (parsed[part]) parsed[part] = mdurl.encode(parsed[part]);
  return mdurl.format(parsed);
}
/** A URL decoded for display. */
export function normalizeLinkText(url: string): string {
  const parsed = mdurl.parse(url, true);
  if (parsed.hostname && (!parsed.protocol || RECODE_HOSTNAME_FOR.includes(parsed.protocol))) {
    try { parsed.hostname = punycode.toUnicode(parsed.hostname); } catch { /* keep the hostname as written */ }
  }
  return mdurl.decode(mdurl.format(parsed), `${mdurl.decode.defaultChars}%`);
}
