/*!
 * The block and inline readers in this directory follow the algorithms of
 * markdown-it 15.0.3 (https://github.com/markdown-it/markdown-it), whose output
 * they reproduce exactly, under its license:
 *
 * Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin.
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
// A configured Markdown reader: block and inline rule lists, the core passes
// that run between them, and options. Expressmark builds one per rule set.
import { ParserBlock, StateBlock, type Env } from "./block.js";
import { ParserInline, StateInline } from "./inline.js";
import { linkify as bareLinks, type Linkify } from "./linkify.js";
import { normalizeLink, normalizeLinkText, parseLinkLabel, validateLink } from "./links.js";
import { Ruler } from "./ruler.js";
import { Token } from "./token.js";
import { unescapeAll } from "./utils.js";

export interface EngineOptions { html: boolean; linkify: boolean; maxNesting: number }
class StateCore {
  tokens: Token[] = [];
  inlineMode = false;
  /** A top-level line where the block pass stops, for reading part of a document. */
  stop: ((line: number) => boolean) | undefined;
  constructor(public src: string, public md: Engine, public env: Env) {}
}
type CoreRule = (state: StateCore) => void;

const normalize: CoreRule = state => { state.src = state.src.replace(/\r\n?/g, "\n").replace(/\0/g, "�"); };
const block: CoreRule = state => {
  if (!state.inlineMode) { state.md.block.parse(state.src, state.md, state.env, state.tokens, state.stop); return; }
  const token = new Token("inline", "", 0);
  token.content = state.src; token.map = [0, 1]; token.children = [];
  state.tokens.push(token);
};
const strip_references: CoreRule = state => {
  const kept = state.tokens.filter(token => token.type !== "reference_definition");
  state.tokens.length = 0; state.tokens.push(...kept);
};
const inline: CoreRule = state => {
  for (const token of state.tokens) if (token.type === "inline") state.md.inline.parse(token.content, state.md, state.env, token.children!);
};
// Every link the detector finds holds a scheme's `:`, `//`, an email's `@` or
// `www.`; text with none of them is not searched.
const mayLink = (text: string) => text.includes(":") || text.includes("@") || text.includes("//") || /www\./i.test(text);
// Bare URLs and emails in text become links; text inside links stays text.
const linkifyText: CoreRule = state => {
  if (!state.md.options.linkify) return;
  for (const blockToken of state.tokens) {
    if (blockToken.type !== "inline" || !mayLink(blockToken.content) || !state.md.linkify.test(blockToken.content)) continue;
    const tokens = blockToken.children!;
    const replacements: { index: number; nodes: Token[] }[] = [];
    let htmlLinkLevel = 0;
    for (let i = tokens.length - 1; i >= 0; i--) {
      const current = tokens[i]!;
      if (current.type === "link_close") {
        i--;
        while (tokens[i]!.level !== current.level && tokens[i]!.type !== "link_open") i--;
        continue;
      }
      if (current.type === "html_inline") {
        if (/^<a[>\s]/i.test(current.content) && htmlLinkLevel > 0) htmlLinkLevel--;
        if (/^<\/a\s*>/i.test(current.content)) htmlLinkLevel++;
      }
      if (htmlLinkLevel > 0 || current.type !== "text" || !mayLink(current.content) || !state.md.linkify.test(current.content)) continue;
      const text = current.content;
      let links = state.md.linkify.match(text) ?? [];
      // A match at the start of text right after an escape or entity is no link.
      if (links.length > 0 && links[0]!.index === 0 && i > 0 && tokens[i - 1]!.type === "text_special") links = links.slice(1);
      const nodes: Token[] = [];
      let level = current.level, lastPos = 0;
      for (const found of links) {
        const fullUrl = state.md.normalizeLink(found.url);
        if (!state.md.validateLink(fullUrl)) continue;
        let urlText = found.text;
        if (!found.schema) urlText = state.md.normalizeLinkText(`http://${urlText}`).replace(/^http:\/\//, "");
        else if (found.schema === "mailto:" && !/^mailto:/i.test(urlText)) urlText = state.md.normalizeLinkText(`mailto:${urlText}`).replace(/^mailto:/, "");
        else urlText = state.md.normalizeLinkText(urlText);
        if (found.index > lastPos) { const token = new Token("text", "", 0); token.content = text.slice(lastPos, found.index); token.level = level; nodes.push(token); }
        const open = new Token("link_open", "a", 1);
        open.attrs = [["href", fullUrl]]; open.level = level++; open.markup = "linkify"; open.info = "auto";
        nodes.push(open);
        const label = new Token("text", "", 0);
        label.content = urlText; label.level = level;
        nodes.push(label);
        const close = new Token("link_close", "a", -1);
        close.level = --level; close.markup = "linkify"; close.info = "auto";
        nodes.push(close);
        lastPos = found.lastIndex;
      }
      if (lastPos < text.length) { const token = new Token("text", "", 0); token.content = text.slice(lastPos); token.level = level; nodes.push(token); }
      replacements.push({ index: i, nodes });
    }
    if (!replacements.length) continue;
    const replaced: Token[] = [];
    replacements.reverse();
    let next = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (replacements[next]?.index === i) replaced.push(...replacements[next++]!.nodes);
      else replaced.push(tokens[i]!);
    }
    blockToken.children = replaced;
  }
};
// Escapes and entities read as text_special so linkify skips them; afterwards they join their text.
function joinText(tokens: Token[]): void {
  for (const token of tokens) if (token.type === "text_special") token.type = "text";
  let last = 0, curr = 0;
  const max = tokens.length;
  for (; curr < max; curr++) {
    if (tokens[curr]!.type === "text" && curr + 1 < max && tokens[curr + 1]!.type === "text") tokens[curr + 1]!.content = tokens[curr]!.content + tokens[curr + 1]!.content;
    else { if (curr !== last) tokens[last] = tokens[curr]!; last++; }
  }
  if (curr !== last) tokens.length = last;
}
const text_join: CoreRule = state => {
  for (const blockToken of state.tokens) {
    if (blockToken.type !== "inline") continue;
    for (const token of blockToken.children!) {
      if (token.type === "text_special") token.type = "text";
      if (token.children) joinText(token.children);
    }
    joinText(blockToken.children!);
  }
};

export class Engine {
  options: EngineOptions;
  block = new ParserBlock();
  inline = new ParserInline();
  core = { ruler: new Ruler<CoreRule>() };
  linkify: Linkify;
  helpers = { parseLinkLabel };
  utils = { unescapeAll };
  validateLink = validateLink;
  normalizeLink = normalizeLink;
  normalizeLinkText = normalizeLinkText;
  /** `zero` enables only paragraphs and text, for callers that add the rules they need. */
  constructor(preset: "default" | "zero", options: Partial<EngineOptions> = {}, linkify: Linkify = bareLinks) {
    for (const [name, fn] of [["normalize", normalize], ["block", block], ["strip_references", strip_references], ["inline", inline], ["linkify", linkifyText], ["text_join", text_join]] as const) this.core.ruler.push(name, fn);
    this.linkify = linkify;
    this.options = { html: false, linkify: false, maxNesting: preset === "zero" ? 20 : 100, ...options };
    if (preset === "zero") {
      this.core.ruler.enableOnly(["normalize", "block", "strip_references", "inline", "text_join"]);
      this.block.ruler.enableOnly(["paragraph"]);
      this.inline.ruler.enableOnly(["text"]);
      this.inline.ruler2.enableOnly(["balance_pairs", "fragments_join"]);
    }
  }
  enable(names: readonly string[]): this {
    const found = [this.core.ruler, this.block.ruler, this.inline.ruler, this.inline.ruler2].flatMap(ruler => (ruler as Ruler<unknown>).enable(names, true));
    const missed = names.filter(name => !found.includes(name));
    if (missed.length) throw new Error(`Failed to enable unknown rule(s): ${missed.join(", ")}`);
    return this;
  }
  /** Read `src`; with `stop`, up to the first top-level block whose line `stop` accepts. */
  parse(src: string, env: Env, stop?: (line: number) => boolean): Token[] {
    const state = new StateCore(src, this, env);
    state.stop = stop;
    for (const rule of this.core.ruler.getRules("")) rule(state);
    return state.tokens;
  }
  parseInline(src: string, env: Env): Token[] {
    const state = new StateCore(src, this, env);
    state.inlineMode = true;
    for (const rule of this.core.ruler.getRules("")) rule(state);
    return state.tokens;
  }
}
export { StateBlock, StateInline, Token };
export type { Env };
