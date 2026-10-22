import MarkdownIt, { type StateInline } from "markdown-it";
import { configureAutolinks } from "./autolinks.js";
import { mentionBoundary, normalizeLabel, readAttributes, readLabel, tokenHandle, tokenIdentifier } from "./grammar.js";
import type { Node } from "./types.js";

export interface TextContext {
  block?: boolean;
  label?: boolean;
  heading?: boolean;
  marks?: string;
  protectAutolinks?: boolean;
  mentionStart?: boolean;
  /** Defined footnote labels: only these make `[^label]` a reference. */
  footnotes?: ReadonlySet<string>;
  /** Normalized link reference labels: only these make `[label]` a link. */
  references?: ReadonlySet<string>;
  previous?: Node;
  next?: Node;
}

export function startsMention(context: TextContext): boolean {
  const previous=context.previous;
  if(!previous) return context.mentionStart !== false;
  if(previous.type === "softBreak" || previous.type === "break") return true;
  return previous.type === "text" && /\s$/u.test(previous.value ?? "");
}

function trailingAttributes(value: string): boolean {
  let rest=literalGrammarSource(value);
  while(rest) {
    const attrs=readAttributes(rest);
    if(!attrs) return false;
    rest=rest.slice(attrs.length).trimStart();
  }
  return true;
}

// Stored backslashes are data, not authored escapes. Grammar lookahead must
// see their protected spelling; otherwise doubling a backslash can expose a
// closing bracket/quote and create syntax that was invisible in the raw value.
function literalGrammarSource(value: string): string {
  return value.replace(/[\\`]/g,"\\$&");
}

// Balance literal delimiter runs with the same flanking and pairing rules as
// the reader. Other syntax is disabled: code/link/HTML-shaped literal text must
// not hide punctuation that becomes active once its opener is escaped.
const delimiters=new MarkdownIt("zero");
delimiters.inline.ruler.before("text","literal_delimiters",(state,silent)=> {
  const marker=state.src.charCodeAt(state.pos);
  if(silent || ![42,95,126].includes(marker)) return false;
  const run=state.scanDelims(state.pos,marker !== 95);
  const surrounding=state.env.marks as string;
  if(surrounding.includes(String.fromCharCode(marker)) && (run.can_open || run.can_close || state.pos === 0 || state.pos+run.length === state.src.length)) {
    const escapes=state.env.escapes as Set<number>;
    for(let i=state.pos;i<state.pos+run.length;i++) escapes.add(i);
  }
  if(marker === 126 && run.length<2) return false;
  const step=marker === 126 ? 2:1;
  for(let i=marker === 126 ? run.length%2:0;i<run.length;i+=step) {
    const token=state.push("text","",0);
    token.content=state.src.slice(state.pos+i,state.pos+i+step);
    token.meta={start:state.pos,length:run.length};
    state.delimiters.push({marker,length:marker === 126 ? 0:run.length,token:state.tokens.length-1,end:-1,open:run.can_open,close:run.can_close});
  }
  state.pos+=run.length; return true;
});
delimiters.inline.ruler2.before("fragments_join","literal_pairs",state=> {
  const escapes=state.env.escapes as Set<number>;
  for(const delimiter of state.delimiters) if(delimiter.end !== -1) {
    for(const index of [delimiter.token,state.delimiters[delimiter.end]!.token]) {
      const {start,length}=state.tokens[index]!.meta as {start:number;length:number};
      for(let i=start;i<start+length;i++) escapes.add(i);
    }
  }
});

export const syntax=new MarkdownIt("zero",{html:true}).enable(["link","image","autolink","html_inline"]);
configureAutolinks(syntax);
const syntaxRules=syntax.inline.ruler.getRules("");
function opensInlineSyntax(state: StateInline, offset: number): boolean {
  state.pos=offset;
  return syntaxRules.some(rule=>rule(state,true));
}

export function escapeText(value: string, context: TextContext = {}): string {
  const escapes=new Set<number>();
  const marks=(context.marks ?? "")+[context.previous,context.next].map(node=>node?.type === "delete" ? "~":["strong","emphasis"].includes(node?.type ?? "") ? "*":"").join("");
  if(/[*_~]/.test(value)) delimiters.inline.parse(value,delimiters,{escapes,marks},[]);
  const mixed=Boolean(context.previous || context.next);
  const ticks=Array.from(value.matchAll(/`+/g));
  const counts=new Map<number,number>();
  for(const tick of ticks) counts.set(tick[0].length,(counts.get(tick[0].length) ?? 0)+1);
  for(const tick of ticks) if(mixed || counts.get(tick[0].length)!>1) {
    for(let i=tick.index;i<tick.index+tick[0].length;i++) escapes.add(i);
  }
  const brackets: number[]=[];
  const inlineState=new syntax.inline.State(value,syntax,{},[]);
  for(let i=0;i<value.length;i++) {
    const char=value[i]!;
    if(char === "\\" && (/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~\n]/.test(value[i+1] ?? "") || i === value.length-1 && (context.next || context.label || context.marks))) escapes.add(i);
    if(char === "[" || char === "<") {
      if(opensInlineSyntax(inlineState,i)) {
        escapes.add(i);
        // Escaping an inner link must not expose an outer bracket as a new
        // link opener against the inner link's remaining destination.
        if(char === "[") for(const ancestor of brackets) escapes.add(ancestor);
      }
    }
    if(char === "[" && value[i+1] === "^" && context.footnotes?.size) {
      const label=tokenHandle(value.slice(i+2));
      if(label && value[i+2+label.length] === "]" && context.footnotes.has(label)) escapes.add(i);
    }
    if(char === "[" && value[i+1] !== "^" && context.references?.size) {
      const label=/^\[((?:\\[\s\S]|[^\\[\]])+)\]/.exec(value.slice(i));
      if(label && context.references.has(normalizeLabel(label[1]!))) escapes.add(i);
    }
    if(char === "[") brackets.push(i);
    if(char === "]" && brackets.pop() === undefined && (context.label || mixed)) escapes.add(i);
    if(char === "@" && mentionBoundary(value,i) && (i>0 || startsMention(context))) {
      if(readLabel(literalGrammarSource(value.slice(i+1))) || tokenHandle(value.slice(i+1)) || i === value.length-1 && context.next?.type === "link") escapes.add(i);
    }
    if(char === ":") {
      if(context.block !== false && /(?:^|\n)[ \t]*:$/.test(value.slice(0,i+1)) && context.next?.type === "inline" && context.next.subType !== "mention") escapes.add(i);
      const name=tokenIdentifier(value.slice(i+1));
      if(name && name.toLowerCase() !== "mention") {
        const tail=literalGrammarSource(value.slice(i+1+name.length));
        if(readLabel(tail) || readAttributes(tail) || !tail && context.next?.type === "link") escapes.add(i);
      }
    }
    if(char === "{" && (i === 0 && ["link","image","inline"].includes(context.previous?.type ?? "") || context.heading && !context.next && /\s/u.test(value[i-1] ?? ""))) {
      const rest=value.slice(i);
      if(i === 0 && context.previous ? readAttributes(literalGrammarSource(rest)):trailingAttributes(rest)) escapes.add(i);
    }
  }
  if(context.label || mixed) for(const index of brackets) escapes.add(index);

  if(context.protectAutolinks !== false) for(const match of syntax.linkify.match(value) ?? []) {
    if(match.schema === "mailto:") escapes.add(match.index+match.raw.indexOf("@"));
    else if(/^(?:https?|ftp):/i.test(match.raw)) escapes.add(match.index+match.raw.indexOf(":"));
    else if(/^www\./i.test(match.raw)) escapes.add(match.index+3);
  }

  if(context.block !== false) {
    let offset=0;
    for(const line of value.split("\n")) {
      const leading=/^[ \t]*/.exec(line)![0].length;
      const rest=line.slice(leading);
      if(offset>0 || !context.previous || context.previous.type === "softBreak" || context.previous.type === "break") {
        if(/^(?:#{1,6}(?:[ \t]|$)|>|[+*-](?:[ \t]|$)|\||:{2,}|`{3,}|~{3,}|<(?:[A-Za-z][\w-]*(?:\s|$)|[!?]))/.test(rest)
          || /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$/.test(rest)
          || (offset>0 || context.previous?.type === "softBreak") && /^(?:=+|-+)[ \t]*$/.test(rest)) escapes.add(offset+leading);
        const ordered=/^\d{1,9}([.)])(?=[ \t]|$)/.exec(rest);
        if(ordered) escapes.add(offset+leading+ordered[0].length-1);
        if(/^\[(?:\^[^\]]*\]:|[^\]]+\]:[ \t]*\S)/.test(rest)) escapes.add(offset+leading);
        if(/^[| :\t-]+$/.test(rest) && rest.includes("|") && rest.includes("-")) escapes.add(offset+leading+rest.indexOf("|"));
      }
      offset+=line.length+1;
    }
  }
  if(context.heading && !context.next) {
    const closing=/[ \t](#+)[ \t]*$/.exec(value);
    if(closing) escapes.add(closing.index+1);
  }
  // Encode only references the reader actually decodes. Invalid entity-like
  // words and ordinary ampersands stay readable.
  return Array.from(value.matchAll(/&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]*);|[\s\S]/g),match=> {
    if(match[0].length>1 && syntax.utils.unescapeAll(match[0]) !== match[0]) return `&amp;${match[0].slice(1)}`;
    return `${escapes.has(match.index) ? "\\":""}${match[0]}`;
  }).join("");
}
