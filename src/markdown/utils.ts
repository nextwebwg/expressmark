// Character classes and text helpers shared by the block and inline readers.
import { decodeHTMLStrict } from "entities";
import { P, S } from "uc.micro";

export const isSpace = (code: number): boolean => code === 0x20 || code === 0x09;

/** Unicode `Zs` or `\t`, `\n`, `\v`, `\f`, `\r`: CommonMark's whitespace. */
export function isWhiteSpace(code: number): boolean {
  if (code >= 0x2000 && code <= 0x200a) return true;
  switch (code) {
    case 0x09: case 0x0a: case 0x0b: case 0x0c: case 0x0d: case 0x20: case 0xa0: case 0x1680: case 0x202f: case 0x205f: case 0x3000: return true;
  }
  return false;
}

export const fromCodePoint = (code: number): string => {
  if (code > 0xffff) { code -= 0x10000; return String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff)); }
  return String.fromCharCode(code);
};
/** Unicode punctuation or symbol, from the Unicode tables the link detector shares. */
export const isPunctCharCode = (code: number): boolean => { const char = fromCodePoint(code); return P.test(char) || S.test(char); };

/** CommonMark's ASCII punctuation. */
export function isMdAsciiPunct(code: number): boolean {
  return code >= 0x21 && code <= 0x2f || code >= 0x3a && code <= 0x40 || code >= 0x5b && code <= 0x60 || code >= 0x7b && code <= 0x7e;
}

export function isValidEntityCode(code: number): boolean {
  if (code >= 0xd800 && code <= 0xdfff) return false;
  if (code >= 0xfdd0 && code <= 0xfdef) return false;
  if ((code & 0xffff) === 0xffff || (code & 0xffff) === 0xfffe) return false;
  if (code >= 0x00 && code <= 0x08 || code === 0x0b || code >= 0x0e && code <= 0x1f || code >= 0x7f && code <= 0x9f) return false;
  return code <= 0x10ffff;
}

const UNESCAPE_MD_RE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;
const UNESCAPE_ALL_RE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])|&([a-z#][a-z0-9]{1,31});/gi;
const DIGITAL_ENTITY_TEST_RE = /^#((?:x[a-f0-9]{1,8}|[0-9]{1,8}))$/i;
function replaceEntity(match: string, name: string): string {
  if (name.charCodeAt(0) === 0x23 && DIGITAL_ENTITY_TEST_RE.test(name)) {
    const code = name[1]!.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return isValidEntityCode(code) ? fromCodePoint(code) : match;
  }
  return decodeHTMLStrict(match);
}
export function unescapeMd(text: string): string {
  return text.includes("\\") ? text.replace(UNESCAPE_MD_RE, "$1") : text;
}
/** Decode backslash escapes and character references, as destinations, titles and info strings do. */
export function unescapeAll(text: string): string {
  if (!text.includes("\\") && !text.includes("&")) return text;
  return text.replace(UNESCAPE_ALL_RE, (match: string, escaped: string | undefined, entity: string | undefined) => escaped ?? replaceEntity(match, entity!));
}

/** CommonMark label matching: trimmed, whitespace collapsed and case-folded. */
export function normalizeReference(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase();
}

const trimmable = (code: number) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
/** Trim ASCII whitespace only, keeping Unicode spaces at the edges of headings and paragraphs. */
export function asciiTrim(text: string): string {
  let start = 0, end = text.length;
  while (start < end && trimmable(text.charCodeAt(start))) start++;
  while (end > start && trimmable(text.charCodeAt(end - 1))) end--;
  return start === 0 && end === text.length ? text : text.slice(start, end);
}
