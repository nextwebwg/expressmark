/*!
 * Bare URL and email detection follows linkify-it 6.1.0
 * (https://github.com/markdown-it/linkify-it), whose matches it reproduces
 * exactly, under its license:
 *
 * Copyright (c) 2015 Vitaly Puzrin.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
// Bare URLs and emails in text: GFM's autolink extension as linkify-it reads
// it with its default options. Parseman grammars recognize each part at a
// position: a scheme name and the boundary before it, the tail each scheme
// takes, an email's host after `@` and its name before. The scans below find
// candidates in text order and choose between them as linkify-it does.
import { Any, Cc, P, Z } from "uc.micro";
import { regex, type Combinator } from "parseman";
import { reach } from "./lexicon.js";

/** A link found in text: its scheme (empty for none), offsets, source text and URL. */
export interface LinkMatch { schema: string; index: number; lastIndex: number; raw: string; text: string; url: string }
type Validate = (text: string, pos: number) => number;

// ---- The patterns, built as linkify-it builds them for its default options.

const ZPCc = [Z.source, P.source, Cc.source].join("|");
const ZCc = [Z.source, Cc.source].join("|");
const separators = "[><\\uff5c]";
const pseudoLetter = `(?:(?!${separators}|${ZPCc})${Any.source})`;
const escapeRE = (text: string) => text.replace(/[.?*+^$[\]\\(){}|-]/g, "\\$&");
function nestedPair(open: string, close: string): string {
  const atom = `(?:(?!${ZCc}|${escapeRE(open)}|${escapeRE(close)}).)`;
  let pair = `${escapeRE(open)}${atom}{0,1000}${escapeRE(close)}`;
  for (let level = 2; level <= 4; level++) pair = `${escapeRE(open)}(?:${atom}|${pair}){0,1000}${escapeRE(close)}`;
  return pair;
}
const ip4 = "(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])[.]){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])";
const h16 = "[0-9A-Fa-f]{1,4}", ls32 = `(?:(?:${h16}:${h16})|${ip4})`;
const ip6 = `(?:(?:${h16}:){6}${ls32}|::(?:${h16}:){5}${ls32}|(?:${h16})?::(?:${h16}:){4}${ls32}|(?:(?:${h16}:){0,1}${h16})?::(?:${h16}:){3}${ls32}|(?:(?:${h16}:){0,2}${h16})?::(?:${h16}:){2}${ls32}|(?:(?:${h16}:){0,3}${h16})?::${h16}:${ls32}|(?:(?:${h16}:){0,4}${h16})?::${ls32}|(?:(?:${h16}:){0,5}${h16})?::${h16}|(?:(?:${h16}:){0,6}${h16})?::)`;
const ip6UrlHost = `\\[${ip6}\\]`, ip6MailHost = `\\[IPv6:${ip6}\\]`;
const port = "(?::(?:6(?:[0-4]\\d{3}|5(?:[0-4]\\d{2}|5(?:[0-2]\\d|3[0-5])))|[1-5]?\\d{1,4}))?";
const hostTerminator = `(?=$|${separators}|${ZPCc})(?!-|_|:\\d|\\.-|\\.(?!$|${ZPCc}))`;
const path = `(?:[/?#](?:${nestedPair("[", "]")}|${nestedPair("(", ")")}|${nestedPair("{", "}")}|\\"(?:(?!${ZCc}|["]).){1,100}\\"|\\'(?:(?!${ZCc}|[']).){1,100}\\'|\\'(?=${pseudoLetter}|[-])|\\.{2,20}[:]?[a-zA-Z0-9%/&]|\\.(?!${ZCc}|[.]|$)|\\-{1,20}|,(?!${ZCc}|$)|;(?!${ZCc}|$)|\\!{1,20}(?!${ZCc}|[!]|$)|\\?(?!${ZCc}|[?]|$)|[\\\\/:%@#&=_~*]|(?!${ZPCc}|${separators}).){1,10000}|\\/)?`;
const mailName = "[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9](?:[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9]|[.](?=[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9])){0,63}";
const xn = "xn--[a-z0-9\\-]{1,59}";
const domainRoot = `(?:${xn}|${pseudoLetter}{1,63})`;
const domain = `(?:${xn}|(?:${pseudoLetter})|(?:${pseudoLetter}(?:-|${pseudoLetter}){0,61}${pseudoLetter}))`;
const urlHostPort = `(?:${ip6UrlHost}|(?:(?:(?:${domain})\\.){0,10}${domain}))${port}${hostTerminator}`;
const mailHost = `(?:${ip6MailHost}|(?:(?:(?:${domain})\\.){0,4}${domain}))${hostTerminator}`;
const fuzzyMailHost = `(?:${ip6MailHost}|(?:(?:(?:${domain})[.]){1,4}${domainRoot}))${hostTerminator}`;

// ---- The grammars.

const maxLength = 10000;
/** The scheme names, in the order linkify-it tries them. */
const schemaNames = ["http:", "https:", "ftp:", "//", "mailto:", "www."];
const schemaName = regex(schemaNames.map(escapeRE).join("|"), "i");
/** The character before a scheme: a separator, space, punctuation or control, but no `_`. */
const schemaBoundary = regex(`(?!_)(?:${separators}|${ZPCc})`);
const httpTail = regex(`\\/\\/${urlHostPort}${path}`, "i");
const relativeTail = regex(`(?:localhost|${ip6UrlHost}|(?:(?:${domain})[.]){1,10}${domainRoot})${port}${hostTerminator}${path}`, "i");
const mailtoTail = regex(`${mailName}@${mailHost}`, "i");
const emailHost = regex(fuzzyMailHost, "i");
/** An email name running to the end of the text. */
const nameToEnd = regex(`${mailName}$`);
/** What may precede an email name. */
const nameBoundary = regex(`(?:${separators}|"|\\(|${ZCc})`);

const tail = (grammar: Combinator<unknown>): Validate => (text, pos) => Math.max(0, reach(grammar, text, pos) - pos);
const web = tail(httpTail);
const schemas: Record<string, Validate> = {
  "http:": web, "https:": web, "ftp:": web,
  // `//` after `:` or `/` belongs to a longer scheme or path.
  "//": (text, pos) => {
    const length = tail(relativeTail)(text, pos);
    return length && pos >= 3 && (text[pos - 3] === ":" || text[pos - 3] === "/") ? 0 : length;
  },
  "mailto:": tail(mailtoTail),
  // GFM's `www.` links read as `http://www.` ones do.
  "www.": (text, pos) => {
    const length = testSchemaAt(`//www.${text.slice(pos)}`, "http:", 0);
    return length > 6 ? length - 6 : 0;
  },
};

/** The length of the tail `schema` takes at `pos`, or 0. */
function testSchemaAt(text: string, schema: string, pos: number): number {
  const validate = schemas[schema.toLowerCase()];
  return validate ? validate(text.length > pos + maxLength ? text.slice(0, pos + maxLength) : text, pos) : 0;
}

// A scheme name starts with one of these.
const schemaStart = (code: number) => code === 0x68 || code === 0x48 || code === 0x66 || code === 0x46 || code === 0x2f || code === 0x6d || code === 0x4d || code === 0x77 || code === 0x57;

/**
 * The first scheme name that starts the text, when `from` is 0, or follows a
 * boundary character at or after `from`: its offset, its end and its text.
 * A boundary character is one or two code units, and each start position
 * reads as at most one, so scheme names come in the order of their boundaries.
 */
function nextSchema(text: string, from: number): { index: number; lastIndex: number; schema: string } | undefined {
  for (let at = from; at < text.length; at++) {
    if (!schemaStart(text.charCodeAt(at))) continue;
    const end = reach(schemaName, text, at);
    if (end < 0) continue;
    if (at === 0 || at - 1 >= from && reach(schemaBoundary, text, at - 1) === at || at - 2 >= from && reach(schemaBoundary, text, at - 2) === at) {
      return { index: at, lastIndex: end, schema: text.slice(at, end) };
    }
  }
  return undefined;
}

/** The first email host after an `@` at or after `from`: the `@`'s offset and the host's end. */
function nextEmailHost(text: string, from: number): { index: number; lastIndex: number } | undefined {
  for (let at = text.indexOf("@", from); at >= 0; at = text.indexOf("@", at + 1)) {
    const end = reach(emailHost, text, at + 1);
    if (end > at + 1) return { index: at, lastIndex: end };
  }
  return undefined;
}

/** The email name ending at `at`, read from the 65 characters before it. */
function emailName(text: string, at: number): string | undefined {
  const before = text.slice(Math.max(0, at - 65), at);
  for (let start = 0; start <= before.length; start++) {
    if (start === 0 && reach(nameToEnd, before, 0) === before.length) return before;
    if (reach(nameBoundary, before, start) === start + 1 && reach(nameToEnd, before, start + 1) === before.length) return before.slice(start + 1);
  }
  return undefined;
}

function link(text: string, schema: string, index: number, lastIndex: number): LinkMatch {
  const raw = text.slice(index, lastIndex);
  const match: LinkMatch = { schema: schema.toLowerCase(), index, lastIndex, raw, text: raw, url: raw };
  if (match.schema === "www.") match.url = `http://${raw}`;
  else if (match.schema === "mailto:" && !/^mailto:/i.test(match.url)) match.url = `mailto:${match.url}`;
  return match;
}

/** Whether `text` holds a link. */
export function test(text: string): boolean {
  if (!text.length) return false;
  for (let found = nextSchema(text, 0); found; found = nextSchema(text, found.lastIndex)) if (testSchemaAt(text, found.schema, found.lastIndex)) return true;
  if (text.includes("@")) {
    for (let host = nextEmailHost(text, 0); host; host = nextEmailHost(text, host.lastIndex)) if (emailName(text, host.index) !== undefined) return true;
  }
  return false;
}

/** Every link in `text`, in order, or null when it holds none. */
export function match(text: string): LinkMatch[] | null {
  if (!text.length) return null;
  const result: LinkMatch[] = [];
  let schemaFrom = 0, emailFrom = 0, pos = 0;
  let schemaDone = false, emailDone = false;
  let prefix: { index: number; lastIndex: number; schema: string } | undefined;
  let email: { schema: string; index: number; lastIndex: number } | undefined;
  for (;;) {
    const scanFrom = Math.max(pos - 1, 0);
    if (!emailDone && (!email || email.index < pos)) {
      if (emailFrom < scanFrom) emailFrom = scanFrom;
      for (;;) {
        const host = nextEmailHost(text, emailFrom);
        if (!host) { emailDone = true; email = undefined; break; }
        emailFrom = host.lastIndex;
        const name = emailName(text, host.index);
        if (name === undefined) continue;
        email = { schema: "mailto:", index: host.index - name.length, lastIndex: host.lastIndex };
        if (email.index >= pos) break;
        if (emailFrom < scanFrom) emailFrom = scanFrom;
      }
    }
    let candidate: { schema: string; index: number; lastIndex: number } | undefined;
    if (!schemaDone) for (;;) {
      if (!prefix) {
        if (schemaFrom < scanFrom) schemaFrom = scanFrom;
        prefix = nextSchema(text, schemaFrom);
        if (!prefix) { schemaDone = true; break; }
        schemaFrom = prefix.lastIndex;
      }
      if (prefix.index < pos) { prefix = undefined; continue; }
      if (email && prefix.index > email.index) break;
      const found = prefix;
      prefix = undefined;
      const length = testSchemaAt(text, found.schema, found.lastIndex);
      if (length) { candidate = { schema: found.schema, index: found.index, lastIndex: found.lastIndex + length }; break; }
    }
    if (!candidate || email && (email.index < candidate.index || email.index === candidate.index && email.lastIndex > candidate.lastIndex)) candidate = email;
    if (!candidate) break;
    if (candidate === email) email = undefined;
    result.push(link(text, candidate.schema, candidate.index, candidate.lastIndex));
    pos = candidate.lastIndex;
  }
  return result.length ? result : null;
}

/** A link with a scheme at the start of `text`, or null. */
export function matchAtStart(text: string): LinkMatch | null {
  if (!text.length) return null;
  let at = -1;
  if (reach(schemaName, text, 0) > 0) at = 0;
  else {
    const after = reach(schemaBoundary, text, 0);
    if (after > 0 && reach(schemaName, text, after) > after) at = after;
  }
  if (at < 0) return null;
  const end = reach(schemaName, text, at);
  const schema = text.slice(at, end);
  const length = testSchemaAt(text, schema, end);
  return length ? link(text, schema, at, end + length) : null;
}

/** The detector readers and writers share. */
export const linkify = { test, match, matchAtStart };
export type Linkify = typeof linkify;
