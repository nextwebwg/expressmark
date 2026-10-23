import MarkdownIt, { type Token, type StateBlock, type StateInline } from "markdown-it";
import { parseDocument as yamlDocument, isMap, isSeq, isScalar } from "yaml";
import { configureAutolinks } from "./autolinks.js";
import { footnoteDefinitions, referenceOrder } from "./references.js";
import { alertMarker, attach, compact, contentHash, contentHashes, destination, plainText, quoteAttribute, readInfo, rememberSpellings, writeAttributes, structuralTypes, diagnoseIds, mentionBoundary, readAttributes, readHeader, readLabel, tokenHandle, tokenIdentifier } from "./grammar.js";
import { escapeHtml, htmlNodes, normalizeTags, parentEndCloses, readStartTag, sanitizeFragment, sanitizeStartTag, sanitizeHtml, sanitizeLiteral, TagStack, unmatchedTags, voidElements } from "./html.js";
import { mergeTable, readListTable, readTableField } from "./tables.js";
import { installModern, modernRules, type ModernRule } from "./modern.js";
import type { ConversionOptions, Document, Json, Node, Position, Syntax } from "./types.js";
import { linting, warn } from "./types.js";
import { lint } from "./lint.js";

function line(state: StateBlock, index: number): string {
  return state.src.slice(state.bMarks[index]! + state.tShift[index]!, state.eMarks[index]);
}
function normalizeTabs(nodes: Node[], explicit = false): Node[] {
  const output: Node[] = [];
  for (const node of nodes) {
    if (node.body) node.body = normalizeTabs(node.body, node.type === "container" && node.subType === "tabs");
    if (node.children) node.children = node.children.map(child => {
      if (child.body) child.body = normalizeTabs(child.body);
      return child;
    });
    if (!explicit && node.type === "container" && node.subType === "tab") {
      const last = output.at(-1);
      if (last?.type === "container" && last.subType === "tabs" && !last.id && !last.title && !last.attributes && last.source?.automatic === true) last.body!.push(node);
      else output.push({type:"container",subType:"tabs",body:[node],source:{automatic:true}});
    } else output.push(node);
  }
  // Automatic status is lexical, not retained semantic source data.
  return output;
}
function clearAutomatic(node: Node): void {
  if (node.source?.automatic) delete node.source;
  for (const child of node.body ?? node.children ?? []) clearAutomatic(child);
}

// Record an authored spelling in source provenance; the preferred spelling is never recorded.
let spelled=false;
function spell(node: Node, key: string, value: string | number): void {
  node.source={...node.source,[key]:value}; spelled=true;
}
// The fence the writer chooses for code without a recorded spelling.
function codeFence(node: Node): string {
  const marker=[node.language,node.meta].some(value=>value?.includes("`")) ? "~":"`";
  return marker.repeat(Math.max(3,...Array.from((node.value ?? "").matchAll(new RegExp(`${marker}+`,"g")),m=>m[0].length+1)));
}
export function parse(markdown: string, options: ConversionOptions = {}): Document {
  spelled=false;
  if (typeof markdown !== "string") throw new TypeError("Markdown must be a string.");
  const document: Document = {type:"document",version:1,body:[]};
  // The `modern` rules in force, known once the frontmatter is read.
  const modern=new Set<ModernRule>();
  // Lint warnings report the source lines of the block holding each construct.
  const positions=new WeakMap<Node,Position>();
  let lineOffset=0;
  const md = new MarkdownIt({html:true,linkify:true,typographer:false});
  const lexicalMd=new MarkdownIt({html:true});
  // Per block state: table cells parse their own sources.
  const lexicalRanges=new WeakMap<StateBlock,Map<string,{from:number;ranges:Map<number,number>}>>();
  configureAutolinks(md);
  // Definition labels, collected by the block pass before any inline content is read.
  const footnotes=new Set<string>();
  const defined=new Set<string>();
  const env: Record<string,unknown> = {};
  const tasks=new WeakMap<Node,RegExpExecArray>();
  let source = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g,"\n");
  let recoveredFrontmatter: Node | undefined;
  let frontmatterValid=false;

  let lineMode = 0;
  function inline(source: string, lineBlock = false): Node[] {
    if(lineBlock) lineMode++;
    const tokens = md.parseInline(source,env)[0]?.children ?? [];
    if(lineBlock) lineMode--;
    return inlineTokens(tokens,lineBlock);
  }
  function title(node: Node): void {
    if (typeof node.title === "object" && node.title.value !== undefined) node.title=compact({type:"title"},inline(node.title.value));
  }
  function promote(node: Node): void {
    if (node.subType === "mention" && node.attributes?.ref !== undefined) {
      if (typeof node.attributes.ref === "string") { node.ref=node.attributes.ref; delete node.attributes.ref; }
      else warn(options,"invalid-mention-reference","A mention reference must be a string.");
    }
    if (node.type === "code" && node.attributes?.title !== undefined && typeof node.attributes.title === "string") {
      node.title=node.attributes.title; delete node.attributes.title;
    }
    if (node.attributes && Object.keys(node.attributes).length === 0) delete node.attributes;
  }
  md.inline.ruler.before("backticks","expressive_line_code",(state,silent)=> {
    if(!lineMode || state.src[state.pos] !== "`") return false;
    const ticks=/^`+/.exec(state.src.slice(state.pos))![0];
    const close=state.src.indexOf(ticks,state.pos+ticks.length);
    if(close<0 || !state.src.slice(state.pos+ticks.length,close).includes("\n")) return false;
    if(!silent) state.push("text","",0).content=ticks;
    state.pos+=ticks.length; return true;
  });
  md.inline.ruler.before("emphasis","expressive",(state: StateInline,silent: boolean) => {
    const start=state.pos;
    const marker=state.src[start];
    if (marker !== ":" && marker !== "@") return false;
    let cursor=start+1;
    let subtype: string;
    let label: string | undefined;
    let ref: string | undefined;
    let bare=false;
    if(marker === "@") {
      if (!mentionBoundary(state.src,start)) return false;
      subtype="mention";
      if(state.src[cursor] === "[") {
        const found=readLabel(state.src.slice(cursor)); if(!found) return false;
        label=found.value; cursor+=found.length;
      } else {
        const found=tokenHandle(state.src.slice(cursor)); if(!found) return false;
        label=found; cursor+=found.length; bare=true;
      }
      if(state.src[cursor] === "#") {
        ref=tokenHandle(state.src.slice(cursor+1)); if(ref) cursor+=ref.length+1;
      }
    } else {
      const found=tokenIdentifier(state.src.slice(cursor)); if(!found) return false;
      subtype=found.toLowerCase(); cursor+=found.length;
      // Mentions use @ source syntax; the generic directive form is not an alias.
      if(subtype === "mention") return false;
      if(state.src[cursor] === "[") {
        const bracket=readLabel(state.src.slice(cursor)); if(!bracket) return false;
        label=bracket.value; cursor+=bracket.length;
      }
    }
    const node: Node={type:"inline",subType:subtype};
    if(ref !== undefined) node.ref=ref;
    let attached=false;
    const attributesStart=cursor;
    while(state.src[cursor] === "{") {
      const attrs=readAttributes(state.src.slice(cursor),options); if(!attrs) break;
      attach(node,attrs); cursor+=attrs.length; attached=true;
    }
    if(label === undefined && !attached) return false;
    // A silent match still consumes its source: link-label scans advance by it.
    if(silent) { state.pos=cursor; return true; }
    if(label !== undefined) compact(node,inline(label));
    promote(node);
    if(bare) spell(node,"form","bare");
    const authored=state.src.slice(attributesStart,cursor);
    // A mention writes a non-handle reference as a ref attribute.
    const canonical=writeAttributes(node,subtype === "mention" && node.ref !== undefined && tokenHandle(node.ref) !== node.ref ? {ref:node.ref}:{});
    if(authored && authored !== canonical) spell(node,"attributes",authored);
    const token=state.push("expressive_inline","",0); token.meta={node};
    state.pos=cursor;
    return true;
  });
  md.inline.ruler.after("expressive","expressive_attachment",(state: StateInline,silent: boolean) => {
    if(state.src[state.pos] !== "{") return false;
    const last=state.tokens.at(-1);
    if(!last || !["image","link_close"].includes(last.type)) return false;
    const attrs=readAttributes(state.src.slice(state.pos),options); if(!attrs) return false;
    if(silent) { state.pos+=attrs.length; return true; }
    const existing=(last.meta ?? {}) as {attributes?: ReturnType<typeof readAttributes>[]};
    existing.attributes=[...(existing.attributes ?? []),attrs]; last.meta=existing;
    (last.meta as {attributesSource?: string}).attributesSource=`${(last.meta as {attributesSource?: string}).attributesSource ?? ""}${state.src.slice(state.pos,state.pos+attrs.length)}`;
    state.pos+=attrs.length;
    return true;
  });
  md.block.ruler.before("reference","footnote_definition",(state,start,end,silent) => {
    if(state.sCount[start]! - state.blkIndent >= 4) return false;
    const begin=state.bMarks[start]!+state.tShift[start]!;
    const match=/^\[\^([^\]]*)\]:/.exec(state.src.slice(begin,state.eMarks[start]));
    if(!match || tokenHandle(match[1]!) !== match[1]) return false;
    if(silent) return true;
    footnotes.add(match[1]!);
    const opened=state.push("footnote_open","",1); opened.meta={label:match[1]}; const lines: [number,number]=[start,start+1]; opened.map=lines;
    // Read the note like a list item: its first line starts after the marker,
    // and its continuation lines are indented four columns past the marker, or
    // in `modern` syntax, past the marker by any amount, as list nesting is.
    const saved={bMark:state.bMarks[start]!,tShift:state.tShift[start]!,sCount:state.sCount[start]!,parentType:state.parentType};
    let position=begin+match[0].length;
    const contentStart=position;
    let offset=state.sCount[start]!+match[0].length;
    const initial=offset;
    while(position<state.eMarks[start]! && (state.src[position] === " " || state.src[position] === "\t")) {
      offset+=state.src[position] === "\t" ? 4-((offset+state.bsCount[start]!)%4):1;
      position++;
    }
    state.tShift[start]=position-contentStart;
    state.sCount[start]=offset-initial;
    state.bMarks[start]=contentStart;
    const outer=state.blkIndent;
    state.blkIndent=modern.has("relativeLists") ? saved.sCount+1 : outer+4;
    state.parentType="footnote" as typeof state.parentType;
    if(state.sCount[start]! < state.blkIndent) state.sCount[start]!+=state.blkIndent;
    state.md.block.tokenize(state,start,end);
    lines[1]=state.line;
    state.parentType=saved.parentType;
    state.blkIndent=outer;
    state.tShift[start]=saved.tShift; state.sCount[start]=saved.sCount; state.bMarks[start]=saved.bMark;
    state.push("footnote_close","",-1);
    return true;
  },{alt:["paragraph","reference"]});
  // Reference definitions and reference links keep their authored form. Wrap
  // markdown-it's own rules so CommonMark decides what matches; then record it.
  type Rule<T> = {__rules__:{name:string;fn:T}[]};
  const original=<T,>(ruler: unknown, name: string)=>(ruler as Rule<T>).__rules__.find(rule=>rule.name === name)!.fn;
  const referenceRule=original<(state: StateBlock,start: number,end: number,silent: boolean)=>boolean>(md.block.ruler,"reference");
  md.block.ruler.at("reference",(state,start,end,silent) => {
    const env=state.env as {references?: Record<string,{href:string;title:string}>};
    const outer=env.references ?? {};
    // A fresh table reveals this definition's values even when an earlier one
    // already owns the label; the first definition still wins for resolution.
    const own: NonNullable<typeof env.references>={};
    env.references=own;
    let matched: boolean;
    try { matched=referenceRule(state,start,end,silent); } finally { env.references=outer; }
    if(!matched || silent) return matched;
    const [key,value]=Object.entries(own)[0]!;
    // markdown-it's own token keeps only the normalized label; record the authored one.
    const raw=/^\[((?:\\[\s\S]|[^\\[\]])*)\]:/.exec(state.getLines(start,state.line,state.blkIndent,false).trimStart())!;
    if(key in outer) {
      warn(options,"duplicate-definition",`Link reference [${raw[1]}] is defined more than once; the ${modern.has("lastDefinition") ? "last":"first"} definition is used.`);
      if(modern.has("lastDefinition")) outer[key]=value;
    } else outer[key]=value;
    state.tokens.at(-1)!.meta={label:raw[1],url:value.href,title:value.title,markdown:state.getLines(start,state.line,state.blkIndent,false).trim()};
    return true;
  });
  md.core.ruler.disable("strip_references");
  const newlineRule=original<(state: StateInline,silent: boolean)=>boolean>(md.inline.ruler,"newline");
  md.inline.ruler.at("newline",(state,silent) => {
    // Trailing spaces spell a hard break as well as a backslash does.
    let spaces=0;
    if(state.src[state.pos] === "\n") while(state.pending[state.pending.length-1-spaces] === " ") spaces++;
    const count=state.tokens.length;
    if(!newlineRule(state,silent)) return false;
    const token=state.tokens.slice(count).find(candidate=>candidate.type === "hardbreak");
    if(token && spaces >= 2) token.meta={spaces};
    return true;
  });
  for(const [name,offset] of [["link",0],["image",1]] as const) {
    const rule=original<(state: StateInline,silent: boolean)=>boolean>(md.inline.ruler,name);
    md.inline.ruler.at(name,(state,silent) => {
      const start=state.pos;
      const count=state.tokens.length;
      if(!rule(state,silent)) return false;
      if(silent) return true;
      const labelEnd=state.md.helpers.parseLinkLabel(state,start+offset,name === "link");
      const text=state.src.slice(start+offset+1,labelEnd);
      const rest=state.src.slice(labelEnd+1,state.pos);
      if(rest.startsWith("(")) {
        const token=state.tokens.slice(count).find(candidate=>candidate.type === (name === "link" ? "link_open":"image"))!;
        token.meta={...token.meta,target:rest};
      } else {
        const full=/^\[([\s\S]+)\]$/.exec(rest);
        // Pending text is flushed first, so find the token this rule opened.
        const token=state.tokens.slice(count).find(candidate=>candidate.type === (name === "link" ? "link_open":"image"))!;
        token.meta={...token.meta,reference:{label:full ? full[1]:text,referenceType:full ? "full":rest ? "collapsed":"shortcut"}};
      }
      return true;
    });
  }
  md.inline.ruler.before("link","footnote_reference",(state: StateInline,silent: boolean) => {
    if(state.src[state.pos] !== "[" || state.src[state.pos+1] !== "^") return false;
    const label=tokenHandle(state.src.slice(state.pos+2));
    if(!label || state.src[state.pos+2+label.length] !== "]") return false;
    // An undefined reference stays text, as an unresolved link reference does.
    if(!footnotes.has(label)) { if(!silent) warn(options,"undefined-footnote",`Footnote [^${label}] has no definition; it remains text.`); return false; }
    if(!silent) { const token=state.push("footnote_ref","",0); token.meta={label}; token.content=`[^${label}]`; }
    state.pos+=label.length+3;
    return true;
  });
  md.block.ruler.before("fence","expressive_container",(state,start,end,silent) => {
    if(state.sCount[start]! - state.blkIndent >= 4) return false;
    const opening=/^(:{3,})(.*)$/.exec(line(state,start)); if(!opening) return false;
    const node=readHeader(opening[2]!,options,true); if(!node) return false;
    // The header keeps its spacing after the colons.
    const header=opening[2]!.trimEnd();
    const label=typeof node.title === "object" ? node.title.value : undefined;
    if(header !== " "+[node.subType,label === undefined ? undefined : node.titleSpelling === "unbracketed" ? label : `[${label}]`,writeAttributes(node)].filter(Boolean).join(" ")) spell(node,"header",header);
    spell(node,"fence",opening[1]!.length);
    if(silent) return true;
    const length=opening[1]!.length;
    // A container ends with its enclosing block, such as a list item: its last
    // line comes before the first nonblank line indented less than that block.
    if(state.blkIndent>0) for(let index=start+1;index<end;index++) if(!state.isEmpty(index) && state.sCount[index]!<state.blkIndent) { end=index; break; }
    let close=start+1;
    let code: {mark:string;length:number}|undefined;
    // Let CommonMark locate code/HTML in list and quote contexts too. Jump at
    // a token's opening line so a named field's inline fence can take priority.
    // Code and HTML boundaries for the rest of this block context, read once per
    // context and shared by its later containers, so scanning stays linear.
    const key=`${end}:${state.blkIndent}`;
    let contexts=lexicalRanges.get(state);
    if(!contexts) lexicalRanges.set(state,contexts=new Map());
    let lexical=contexts.get(key);
    if(!lexical || lexical.from>start+1) {
      const ranges=new Map<number,number>();
      for(const token of lexicalMd.parse(state.getLines(start+1,end,state.blkIndent,false),{})) if(["fence","code_block","html_block"].includes(token.type) && token.map) ranges.set(start+1+token.map[0],start+1+token.map[1]);
      lexical={from:start+1,ranges}; contexts.set(key,lexical);
    }
    const literalRanges=lexical.ranges;
    for(;close<end;close++) {
      const text=line(state,close);
      if(!code && literalRanges.has(close)) { close=literalRanges.get(close)!-1; continue; }
      const fieldValue=node.subType === "table" ? readTableField(text.replace(/^[-+*][ \t]+/,""))?.value:undefined;
      const fieldCode=fieldValue === undefined ? undefined:/^(`{3,}|~{3,})/.exec(fieldValue);
      const fence=/^(`{3,}|~{3,})/.exec(text) ?? fieldCode;
      if(fence) {
        const value=fence[1]!;
        if(!code) code={mark:value[0]!,length:value.length};
        else if(value[0] === code.mark && value.length >= code.length && new RegExp(`^${code.mark}{${code.length},}[ \\t]*$`).test(text)) code=undefined;
        continue;
      }
      if(code) continue;
      const ending=/^(:{3,})[ \t]*$/.exec(text);
      if(ending && ending[1]!.length === length) break;
      if(ending && ending[1]!.length > length) break;
    }
    if(close === end || !new RegExp(`^:{${length}}[ \\t]*$`).test(line(state,close))) {
      const token=state.push("expressive_literal","",0);
      token.map=[start,end];
      token.content=sanitizeHtml(state.getLines(start,end,state.blkIndent,false).replace(/\n+$/,""),options);
      warn(options,"unclosed-container","An unclosed or mismatched container is preserved as literal source.");
      state.line=end; return true;
    }
    if(node.subType === "table") {
      const body=state.getLines(start+1,close,state.blkIndent,false);
      const table=state.push("expressive_table","",0); table.meta={node,body,source:state.getLines(start,close+1,state.blkIndent,false).trimEnd()}; table.map=[start,close+1];
      state.line=close+1; return true;
    }
    const token=state.push("expressive_container_open","",1); token.meta={node}; token.map=[start,close+1];
    const oldParent=state.parentType;
    state.parentType="container";
    state.md.block.tokenize(state,start+1,close);
    state.parentType=oldParent;
    state.push("expressive_container_close","",-1);
    state.line=close+1; return true;
  },{alt:["paragraph","reference","blockquote","list"]});
  md.block.ruler.before("paragraph","expressive_leaf",(state,start,_end,silent) => {
    if(state.sCount[start]! - state.blkIndent >= 4) return false;
    const match=/^::(?!:)(.*)$/.exec(line(state,start)); if(!match) return false;
    const node=readHeader(match[1]!,options); if(!node) return false;
    if(silent) return true;
    node.type="leaf"; delete node.body;
    const header=match[1]!.trimEnd();
    const label=typeof node.title === "object" ? node.title.value : undefined;
    if(header !== [node.subType,label === undefined ? undefined : `[${label}]`,writeAttributes(node)].filter(Boolean).join(" ")) spell(node,"header",header);
    const leaf=state.push("expressive_leaf","",0); leaf.meta={node}; leaf.map=[start,start+1];
    state.line=start+1; return true;
  },{alt:["paragraph","reference","blockquote","list"]});
  md.block.ruler.before("paragraph","expressive_line_block",(state,start,end,silent) => {
    if(state.parentType === "table") return false;
    const first=line(state,start);
    if(state.sCount[start]! - state.blkIndent >= 4 || !/^\|(?:[ \t]|$)/.test(first)) return false;
    // The table rule runs first; this only sees pipes that did not open a table.
    if(silent) return true;
    const lines: string[]=[];
    let cursor=start;
    let continuation=false;
    for(;cursor<end;cursor++) {
      const text=line(state,cursor);
      if(/^\|(?:[ \t]|$)/.test(text)) { lines.push(text.slice(1).trimStart()); continuation=Boolean(lines.at(-1)); continue; }
      if(!text.trim()) {
        let next=cursor+1; while(next<end && !line(state,next).trim()) next++;
        if(next<end && /^\|(?:[ \t]|$)/.test(line(state,next))) { lines.push(""); continuation=false; continue; }
        break;
      }
      if(continuation && state.sCount[cursor]! > state.blkIndent) { lines[lines.length-1]+=` ${text.trimStart()}`; continue; }
      break;
    }
    const token=state.push("expressive_line_block","",0);
    token.map=[start,cursor];
    token.content=lines.join("\n");
    const authored=state.getLines(start,cursor,state.blkIndent,false).trimEnd();
    if(authored !== lines.map(value=>value ? `| ${value}`:"|").join("\n")) token.meta={markdown:authored};
    state.line=cursor; return true;
  },{alt:["paragraph","reference","blockquote","list"]});

  function spellTarget(node: Node, target: unknown): void {
    if(typeof target === "string" && target !== `(${destination(node.url ?? "")}${typeof node.title === "string" ? ` ${quoteAttribute(node.title)}`:""})`) spell(node,"target",target);
  }
  function spellAttributes(node: Node, authored: unknown): void {
    if(typeof authored === "string" && authored !== writeAttributes(node)) spell(node,"attributes",authored);
  }
  // An HTML element as a node. The safe profile filters its start tag, and an
  // element it disallows is shown as text, as GitHub's tag filter shows it.
  function elementNodes(name: string, open: string, close: string | undefined, display: "inline" | "block", slot: {body?: Node[]; children?: Node[]; value?: string}): Node[] {
    let kept=open;
    if(!options.trustedHtml && !open.startsWith("</")) {
      kept=sanitizeStartTag(open,options);
      if(!kept.trim()) {
        warn(options,"html-element-escaped",`<${name}> is outside the safe HTML profile; it is shown as text.`);
        const text=(value: string): Node => ({type:"literal",display,value});
        return [text(open),...(slot.body ?? slot.children ?? (slot.value ? [text(slot.value)]:[])),...(close ? [text(close)]:[])];
      }
    }
    const node: Node={type:"htmlElement",display,tag:name,open:kept,...(close ? {close}:{})};
    // Links do not nest: inside `<a>`, a link's text stands for the link.
    const unlink=(nodes: Node[]): Node[] => nodes.flatMap(child => ["link","linkReference"].includes(child.type) ? (child.children ? unlink(child.children) : [{type:"text",value:child.value ?? ""}]) : [child.children ? {...child,children:unlink(child.children)} : child.body ? {...child,body:unlink(child.body)} : child]);
    if(name === "a") { if(slot.body) slot.body=unlink(slot.body); if(slot.children) slot.children=unlink(slot.children); }
    if(slot.body) node.body=slot.body;
    else if(slot.children) compact(node,slot.children);
    else if(slot.value !== undefined) node.value=slot.value;
    return [node];
  }
  // A `modern` HTML tag within inline content, matched as HTML matches tags.
  function inlineElement(tokens: Token[], at: number, lineBlock: boolean): {nodes: Node[]; next: number} {
    const raw=tokens[at]!.content;
    const end=/^<\/([A-Za-z][A-Za-z0-9-]*)[^>]*>$/.exec(raw);
    if(end) {
      if(end[1]!.toLowerCase() === "br") { if(linting(options.lint,"br-end-tag")) options.onDiagnostic?.({code:"br-end-tag",message:"</br> is read as <br>; write <br>.",severity:"warning",preferred:"<br>"}); return {nodes:elementNodes("br",raw,undefined,"inline",{}),next:at+1}; }
      // A closing tag never creates an element: a stray one is ignored.
      warn(options,"stray-end-tag",`${raw} closes no open element; it is ignored.`);
      return {nodes:[{type:"html",display:"inline",value:raw}],next:at+1};
    }
    const tag=/^<[A-Za-z]/.test(raw) ? readStartTag(raw,0) : undefined;
    if(!tag) return {nodes:options.trustedHtml ? [{type:"html",display:"inline",value:raw}] : htmlNodes(raw,"inline",options),next:at+1};
    if(voidElements.has(tag.name) || tag.selfClosing) return {nodes:elementNodes(tag.name,raw,undefined,"inline",{}),next:at+1};
    const open=new TagStack(tag.name);
    let index=at+1, closed=-1, implied=false;
    for(;index<tokens.length;index++) {
      const content=tokens[index]!.content;
      if(tokens[index]!.type !== "html_inline") continue;
      const closing=/^<\/([A-Za-z][A-Za-z0-9-]*)/.exec(content);
      if(closing) { if(open.end(closing[1]!.toLowerCase())) { closed=index; break; } continue; }
      const inner=/^<[A-Za-z]/.test(content) ? readStartTag(content,0) : undefined;
      if(inner && open.start(inner.name,inner.selfClosing)) { implied=true; break; }
    }
    if(closed<0 && !implied && !parentEndCloses.has(tag.name)) warn(options,"unclosed-html-element",`<${tag.name}> has no closing tag; it ends with its paragraph.`);
    const inner=tokens.slice(at+1,index);
    return {nodes:elementNodes(tag.name,raw,closed<0 ? undefined:tokens[closed]!.content,"inline",{children:inlineTokens(inner,lineBlock)}),next:closed<0 ? index:closed+1};
  }
  function inlineTokens(tokens: Token[], lineBlock = false): Node[] {
    let cursor=0;
    function read(until?:string): Node[] {
      const nodes: Node[]=[];
      while(cursor<tokens.length) {
        const token=tokens[cursor++]!;
        if(token.type === until) break;
        if(token.type === "text") nodes.push({type:"text",value:token.content});
        else if(token.type === "expressive_inline") nodes.push(token.meta!.node as Node);
        else if(token.type === "footnote_ref") nodes.push({type:"footnoteReference",label:token.meta!.label as string});
        else if(token.type === "softbreak" || token.type === "hardbreak") {
          const node: Node={type:token.type === "hardbreak" || lineBlock ? "break":"softBreak"};
          if(token.meta?.spaces) spell(node,"spaces",token.meta.spaces as number);
          nodes.push(node);
        } else if(token.type === "code_inline") {
          const node: Node={type:"inlineCode",value:token.content};
          if(token.markup.length !== Math.max(0,...Array.from(token.content.matchAll(/`+/g),m=>m[0].length))+1) spell(node,"fence",token.markup);
          nodes.push(node);
        }
        else if(token.type === "image") {
          const alt=token.children ? token.children.map(t=>t.content).join("") : token.content;
          const reference=token.meta?.reference as Pick<Node,"label"|"referenceType"> | undefined;
          // A reference keeps its label; the definition supplies the target when rendering.
          const node: Node=reference ? {type:"imageReference",...reference,alt} : {type:"image",url:String(token.attrGet("src") ?? ""),alt};
          const tooltip=token.attrGet("title"); if(tooltip !== null && !reference) node.title=String(tooltip);
          for(const attrs of ((token.meta?.attributes ?? []) as NonNullable<ReturnType<typeof readAttributes>>[])) attach(node,attrs);
          spellTarget(node,token.meta?.target); spellAttributes(node,token.meta?.attributesSource);
          nodes.push(node);
        } else if(token.type === "link_open") {
          const reference=token.meta?.reference as Pick<Node,"label"|"referenceType"> | undefined;
          const node=compact(reference ? {type:"linkReference",...reference} : {type:"link",url:String(token.attrGet("href") ?? "")},read("link_close"));
          const tooltip=token.attrGet("title"); if(tooltip !== null && !reference) node.title=String(tooltip);
          for(const attrs of ((tokens[cursor-1]?.meta?.attributes ?? []) as NonNullable<ReturnType<typeof readAttributes>>[])) attach(node,attrs);
          if(token.markup === "autolink" || token.markup === "linkify") spell(node,"form",token.markup === "autolink" ? "angle":"bare");
          spellTarget(node,token.meta?.target); spellAttributes(node,tokens[cursor-1]?.meta?.attributesSource);
          nodes.push(node);
        } else if(["em_open","strong_open","s_open"].includes(token.type)) {
          const type=token.type === "em_open" ? "emphasis" : token.type === "s_open" ? "delete":"strong";
          const node=compact({type},read(token.type.replace("_open","_close")));
          if(token.markup.startsWith("_")) spell(node,"marker","_");
          nodes.push(node);
        } else if(token.type === "html_raw_inline") {
          const meta=token.meta as {name:string;open:string;close?:string;value:string};
          nodes.push(...elementNodes(meta.name,meta.open,meta.close,"inline",{value:meta.value}));
        } else if(token.type === "html_inline" && modern.has("html")) { const found=inlineElement(tokens,cursor-1,lineBlock); nodes.push(...found.nodes); cursor=found.next; }
        else if(token.type === "html_inline" && options.trustedHtml) { if(/^<\/br[\s>]/i.test(token.content)) if(linting(options.lint,"br-end-tag")) options.onDiagnostic?.({code:"br-end-tag",message:"</br> is read as <br>; write <br>.",severity:"warning",preferred:"<br>"}); nodes.push({type:"html",display:"inline",value:token.content}); }
        else if(token.type === "html_inline") {
          const open=/^<([a-z][\w:-]*)\b[^>]*>$/i.exec(token.content);
          if(open && !/\/\s*>$/.test(token.content) && !["br","img","hr","wbr"].includes(open[1]!.toLowerCase())) {
            let nesting=1;
            let end=cursor;
            for(;end<tokens.length;end++) {
              if(tokens[end]!.type !== "html_inline") continue;
              const raw=tokens[end]!.content;
              if(new RegExp(`^<${open[1]}(?:\\s|>)`,"i").test(raw)) nesting++;
              if(new RegExp(`^<\\/${open[1]}[ \\t]*>`,"i").test(raw) && --nesting === 0) break;
            }
            if(end<tokens.length) {
              const marker="EXPRESSIVE_INLINE_CONTENT";
              const wrappers=htmlNodes(`${token.content}${marker}${tokens[end]!.content}`,"inline",options);
              // Sanitize the HTML shell first. Its safe content slot is populated with
              // already-parsed Markdown nodes, so extensions and literal code survive.
              const inner=inlineTokens(tokens.slice(cursor,end),lineBlock);
              function populate(node: Node): Node[] {
                if(node.value === marker) {
                  if(node.type === "text") return inner;
                  delete node.value; compact(node,inner); return [node];
                }
                if(node.children) {
                  const children=node.children.flatMap(populate); delete node.children; if(node.type === "group") {
                    const normalized=compact({type:"paragraph"},children);
                    node.children=normalized.children ?? (normalized.value ? [{type:"text",value:normalized.value}]:[]);
                  } else compact(node,children);
                }
                if(node.body) node.body=node.body.flatMap(populate);
                if(node.type === "html" && node.value?.includes(marker)) {
                  warn(options,"opaque-inline-html","Markdown inside an opaque native HTML element is retained as readable text.");
                  node.value=node.value.replace(marker,escapeHtml(inner.map(plainText).join("")));
                }
                return [node];
              }
              nodes.push(...wrappers.flatMap(populate)); cursor=end+1;
            } else {
              nodes.push(...htmlNodes(token.content,"inline",options));
              if(["script","style","iframe","object","svg","math","template"].includes(open[1]!.toLowerCase())) cursor=tokens.length;
            }
          } else nodes.push(...htmlNodes(token.content,"inline",options));
        } else if(token.nesting === 0 && token.content) nodes.push({type:"literal",display:"inline",value:token.content});
      }
      return nodes;
    }
    return read();
  }
  function blocks(tokens: Token[], original: string): Node[] {
    let cursor=0;
    let sourceLines: string[] | undefined;
    const lineAt=(index: number)=>(sourceLines ??= original.split("\n"))[index] ?? "";
    // The block nodes a token made take its source lines, for lint positions.
    const place=(nodes: Node[], at: number, map: [number,number] | null | undefined)=> {
      if(!map || original !== source) return;
      // Only lint reports the end column, which reading the source's lines gives.
      for(const node of nodes.slice(at)) if(!positions.has(node)) positions.set(node,{start:{line:map[0]+lineOffset+1,column:1},end:{line:map[1]+lineOffset,column:options.lint ? lineAt(map[1]-1).length+1 : 1}});
    };
    // Top-level blocks always take their lines, for writing them back exactly.
    let depth=0;
    function read(until?:string): Node[] {
      depth++;
      const nodes: Node[]=[];
      let made: {at: number; map: [number,number] | null} | undefined;
      const finish=()=>{ if(made && (options.lint || depth === 1)) place(nodes,made.at,made.map); };
      while(cursor<tokens.length) {
        finish();
        const token=tokens[cursor++]!;
        if(token.type === until) break;
        made={at:nodes.length,map:token.map};
        if(token.type === "paragraph_open" || token.type === "heading_open") {
          const inner=tokens[cursor++]!;
          let content=inner.content;
          const attached: NonNullable<ReturnType<typeof readAttributes>>[]=[];
          let attachedSource: string | undefined;
          if(token.type === "heading_open") {
            // Find a complete, whitespace-separated trailing attribute sequence.
            for(let i=0;i<content.length;i++) if(content[i] === "{" && /\s/.test(content[i-1] ?? "")) {
              let position=i; const candidates: typeof attached=[];
              while(position<content.length) {
                const attrs=readAttributes(content.slice(position),options); if(!attrs) break;
                candidates.push(attrs); position+=attrs.length;
                position+=/^[ \t]*/.exec(content.slice(position))![0].length;
              }
              if(position === content.length && candidates.length) { attached.push(...candidates); attachedSource=content.slice(i).trimEnd(); content=content.slice(0,i).trimEnd(); break; }
            }
          }
          // The block pass already parsed inline content. Reparse only when
          // removing heading attachments changes the represented source.
          const children=content === inner.content && inner.children ? inlineTokens(inner.children):inline(content);
          const node=compact(token.type === "paragraph_open" ? {type:"paragraph"} : {type:"heading",level:Number(token.tag.slice(1))},children);
          for(const attrs of attached) attach(node,attrs);
          spellAttributes(node,attachedSource);
          if(token.type === "heading_open" && token.map) {
            if(token.markup === "=" || token.markup === "-") {
              spell(node,"form","setext");
              spell(node,"underline",/[=-]+[ \t]*$/.exec(lineAt(token.map[1]-1))![0].trim());
            } else {
              const closing=/[ \t](#+)[ \t]*$/.exec(lineAt(token.map[0]));
              if(closing) spell(node,"closing",closing[1]!);
            }
          }
          if(token.type === "paragraph_open") { const task=/^\[([ xX])\][ \t]+/.exec(content); if(task) tasks.set(node,task); }
          cursor++; nodes.push(node);
        } else if(token.type === "blockquote_open") {
          // A marker opening the quote's first line makes it an alert: the same
          // callout as a colon container, recording the authored spelling.
          const first=tokens[cursor]?.type === "paragraph_open" ? tokens[cursor+1]!.content : "";
          const marker=alertMarker.exec(first);
          if(marker && !structuralTypes.has(marker[1]!.toLowerCase())) {
            const node: Node={type:"container",subType:marker[1]!.toLowerCase(),spelling:"alert",body:[]};
            // The type matches case-insensitively; its authored case is a spelling.
            if(marker[1] !== node.subType) spell(node,"type",marker[1]!);
            if(marker[2]?.trim()) node.title=compact({type:"title"},inline(marker[2].trim()));
            const rest=first.slice(marker[0].length);
            cursor+=3;
            node.body=[...(rest ? [compact({type:"paragraph"},inline(rest))]:[]),...read("blockquote_close")];
            nodes.push(node);
          } else nodes.push({type:"blockquote",body:read("blockquote_close")});
        }
        else if(token.type === "bullet_list_open" || token.type === "ordered_list_open") {
          const listStart=cursor;
          const node: Node={type:"list",ordered:token.type === "ordered_list_open",tight:true,children:read(token.type.replace("_open","_close"))};
          const start=token.attrGet("start"); if(start !== null && Number(start) !== 1) node.start=Number(start);
          // Only direct item paragraphs determine this list's tightness.
          let loose=false, items=0, same=true;
          for(let index=listStart;index<cursor;index++) {
            const item=tokens[index]!;
            if(item.type === "paragraph_open" && item.level === token.level+2 && !item.hidden) loose=true;
            if(item.type === "list_item_open" && item.level === token.level+1 && items++ && item.info !== tokens[listStart]!.info) same=false;
          }
          // A `modern` list splits at a blank line, so only its items can be loose.
          node.tight=modern.has("looseLists") || !loose;
          // Lint: indentation that mixes tabs and spaces, between items or within one.
          if(options.lint && !modern.has("relativeLists") && original === source && linting(options.lint,"mixed-indentation")) {
            const lead=(index: number)=>/^[ \t]*/.exec(lineAt(index))![0];
            const unrelated=(a: string, b: string)=>!a.startsWith(b) && !b.startsWith(a);
            const items=tokens.slice(listStart,cursor).filter(item=>item.type === "list_item_open" && item.level === token.level+1 && item.map);
            const first=items[0] ? lead(items[0].map![0]) : "";
            if(items.some(item=>unrelated(lead(item.map![0]),first) || Array.from({length:item.map![1]-item.map![0]-1},(_,offset)=>item.map![0]+1+offset).some(index=>lineAt(index).trim() && unrelated(lead(index),lead(item.map![0])))))
              warn(options,"mixed-indentation","A list mixes tabs and spaces in its indentation; tabs count to the next multiple of four columns.");
          }
          if(token.markup !== (node.ordered ? ".":"-")) spell(node,"marker",token.markup);
          if(node.ordered && items>1 && same) spell(node,"numbering","same");
          nodes.push(node);
        } else if(token.type === "list_item_open") {
          const body=read("list_item_close");
          const node: Node={type:"listItem",body};
          if(token.meta?.loose) node.tight=false;
          if(token.meta?.marker) spell(node,"bullet",token.meta.marker as string);
          const first=body[0];
          if(first?.type === "paragraph") {
            const text=first.value ?? (first.children?.[0]?.type === "text" ? first.children[0].value : undefined);
            const task=tasks.get(first);
            if(task) { node.checked=task[1]!.toLowerCase() === "x"; if(task[1] === "X") spell(node,"marker","X"); if(first.value !== undefined) first.value=first.value.slice(task[0].length); else first.children![0]!.value=text!.slice(task[0].length); }
          }
          nodes.push(node);
        } else if(token.type === "fence" || token.type === "code_block") {
          const node: Node={type:"code",value:""};
          // One parser-added terminal LF is removed; authored trailing blank lines remain.
          node.value=token.content.endsWith("\n") ? token.content.slice(0,-1) : token.content;
          Object.assign(node,readInfo(token.info,options),{type:"code"});
          if(token.type === "code_block") spell(node,"form","indented");
          else {
            if(token.markup !== codeFence(node)) spell(node,"fence",token.markup);
            const info=token.info.trim();
            if(info !== [node.language,writeAttributes(node,typeof node.title === "string" ? {title:node.title}:{}),node.meta].filter(Boolean).join(" ")) spell(node,"info",info);
          }
          nodes.push(node);
        } else if(token.type === "hr") {
          const node: Node={type:"horizontalRule"};
          const marker=token.map ? /(?:[-*_][ \t]*){3,}$/.exec(lineAt(token.map[0]).trimEnd())?.[0] : undefined;
          if(marker && marker !== "---") spell(node,"marker",marker);
          nodes.push(node);
        }
        else if(token.type === "html_block") {
          // A block holding only one side of an element, as CommonMark ends HTML
          // at a blank line, stays HTML; rendering nests the Markdown between.
          const value=token.content.trimEnd();
          const unmatched=unmatchedTags(value);
          if(!token.meta?.stray && /<\/br[\s>]/i.test(value)) if(linting(options.lint,"br-end-tag")) options.onDiagnostic?.({code:"br-end-tag",message:"</br> is read as <br>; write <br>.",severity:"warning",preferred:"<br>"});
          if(token.meta?.stray) nodes.push({type:"html",display:"block",value});
          else if(options.trustedHtml) nodes.push({type:"html",display:"block",value});
          else if(unmatched.opens.length || unmatched.closes.length) { const clean=sanitizeFragment(value,options); if(clean.trim()) nodes.push({type:"html",display:"block",value:clean}); }
          else nodes.push(...htmlNodes(value,"block",options));
        }
        else if(token.type === "html_element") {
          // The element's content is Markdown, read as its own block context.
          // Blank lines between its blocks give its paragraphs `<p>`.
          const meta=token.meta as {name:string;open:string;close?:string;content?:string;value?:string};
          if(meta.content === undefined) { nodes.push(...elementNodes(meta.name,meta.open,meta.close,"block",meta.value === undefined ? {}:{value:meta.value})); continue; }
          // Indentation inside an element carries no meaning: its common indentation is removed.
          const lines=meta.content.split("\n");
          const indent=Math.min(...lines.slice(1).filter(text=>text.trim()).map(text=>/^[ \t]*/.exec(text)![0].length));
          const content=Number.isFinite(indent) && indent ? [lines[0],...lines.slice(1).map(text=>text.slice(Math.min(indent,/^[ \t]*/.exec(text)![0].length)))].join("\n") : meta.content;
          const inner=md.parse(content,env);
          const body=blocks(inner,content);
          const covered=new Set<number>();
          for(const child of inner) if(child.level === 0 && child.map) for(let index=child.map[0];index<child.map[1];index++) covered.add(index);
          const loose=lines.some((text,index)=>index>0 && index<lines.length-1 && !text.trim() && !covered.has(index));
          const made=elementNodes(meta.name,meta.open,meta.close,"block",{body});
          const node=made[0]!;
          if(node.type === "htmlElement") {
            if(loose) node.tight=false;
            // The safe profile records the authored source only when it holds no nested HTML to filter.
            if(options.trustedHtml || node.open === meta.open && !meta.content.includes("<")) spell(node,"markdown",`${node.open}${meta.content}${meta.close ?? ""}`);
          }
          nodes.push(...made);
        }
        else if(token.type === "expressive_container_open") {
          // Titles are read after the block pass so they can refer to any footnote.
          const node=token.meta!.node as Node; title(node); node.body=read("expressive_container_close");
          if(node.subType === "tabs" && node.id === undefined && !node.title && !node.attributes) spell(node,"form","explicit");
          nodes.push(node);
        } else if(token.type === "expressive_table") {
          // Convert after the document block pass has collected link references.
          const meta=token.meta as {node:Node;body:string;source:string};
          title(meta.node);
          const table=readListTable(meta.node,meta.body,md,value=>blocks(md.parse(value,env),value));
          if(typeof table === "string") {
            nodes.push({type:"literal",display:"block",value:sanitizeLiteral(meta.source,options)});
            warn(options,"invalid-table",table);
          } else {
            if(typeof meta.node.source?.fence === "number") spell(table,"fence",meta.node.source.fence);
            nodes.push(table);
          }
        }
        else if(token.type === "expressive_leaf") { const node=token.meta!.node as Node; title(node); nodes.push(node); }
        else if(token.type === "reference_definition") {
          const meta=token.meta as {label:string;url:string;title:string;markdown:string};
          const node: Node={type:"definition",label:meta.label,url:meta.url,...(meta.title ? {title:meta.title}:{})};
          const authored=meta.markdown;
          // A title spanning lines has no preferred one-line form, so its source is kept.
          const preferred=typeof node.title === "string" && /[\n\0]/.test(node.title) ? undefined : `[${node.label}]: ${destination(node.url!)}${node.title ? ` ${quoteAttribute(node.title as string)}`:""}`;
          if(authored && authored !== preferred) spell(node,"markdown",authored);
          nodes.push(node);
        }
        else if(token.type === "footnote_open") {
          // Definitions stay where they were written; the renderer collects them.
          const label=token.meta!.label as string;
          if(defined.has(label)) warn(options,"duplicate-footnote",`Footnote [^${label}] is defined more than once; the first definition is the note.`);
          defined.add(label);
          nodes.push({type:"footnoteDefinition",label,body:read("footnote_close")});
        }
        else if(token.type === "expressive_literal") nodes.push({type:"literal",display:"block",value:token.content});
        else if(token.type === "expressive_line_block") {
          const node=compact({type:"lineBlock"},inline(token.content,true));
          if(token.meta?.markdown) spell(node,"markdown",token.meta.markdown as string);
          nodes.push(node);
        }
        else if(token.type === "table_open") {
          const start=cursor-1;
          const rows: Node[]=[];
          const rawCells: string[][]=[];
          while(cursor<tokens.length && tokens[cursor]!.type !== "table_close") {
            const current=tokens[cursor++]!;
            if(current.type !== "tr_open") continue;
            const row: Node={type:"tableRow",children:[]}; const sources:string[]=[];
            while(cursor<tokens.length && tokens[cursor]!.type !== "tr_close") {
              const cellToken=tokens[cursor++]!;
              if(cellToken.type !== "th_open" && cellToken.type !== "td_open") continue;
              const value=tokens[cursor++]!.content; sources.push(value);
              const cell=compact({type:"tableCell"},inline(value));
              if(cellToken.type === "th_open") cell.header=true;
              row.children!.push(cell); cursor++;
            }
            cursor++; rows.push(row); rawCells.push(sources);
          }
          cursor++;
          // markdown-it reports physical CSS values for GFM markers; the public AST uses logical directions.
          const alignment=rows[0]?.children?.map((_cell,index)=> {
            const first=tokens.slice(start,cursor).filter(t=>t.type === "th_open")[index];
            const style=String(first?.attrGet("style") ?? ""); return style?.includes("center") ? "center" : style?.includes("right") ? "end" : style?.includes("left") ? "start" : null;
          }) ?? [];
          const table: Node={type:"table",children:rows};
          if(alignment.some(Boolean)) table.align=alignment;
          const originalRows=token.map ? original.split("\n").slice(token.map[0],token.map[1]).filter((_row,index)=>index !== 1).map(splitRow) : rawCells;
          const hasMerges=originalRows.some(row=>row.some(cell=>/^[>^]$/.test(cell.trim())));
          // Lint: `\|` in a cell's code span, which `modern` syntax keeps as written.
          if(token.map && original === source && !modern.has("tableCode") && linting(options.lint,"table-code-pipe") && /`[^`\n]*\\\|[^`\n]*`/.test(original.split("\n").slice(token.map[0],token.map[1]).join("\n")))
            options.onDiagnostic?.({code:"table-code-pipe",message:"A code span in this table writes \\| for a pipe; in modern syntax the backslash shows, so write |.",severity:"warning",preferred:"| inside the code span",position:{start:{line:token.map[0]+lineOffset+1,column:1},end:{line:token.map[1]+lineOffset,column:lineAt(token.map[1]-1).length+1}}});
          const invalid=hasMerges && originalRows.some(row=>row.length !== (rows[0]?.children?.length ?? 0)) ? "Merged tables require every authored row to supply the same column count." : mergeTable(table,rawCells);
          if(invalid) {
            const range=token.map;
            const value=range ? original.split("\n").slice(range[0],range[1]).join("\n") : rawCells.map(row=>`| ${row.join(" | ")} |`).join("\n");
            nodes.push({type:"literal",display:"block",value:sanitizeHtml(value,options)});
            warn(options,"invalid-table-merge",invalid);
          } else {
            // Pipe source is a second table spelling; its padding is part of it.
            spell(table,"form","pipe");
            // Inside a quote the lines carry its markers; the canonical pipe form applies there.
            const authored=token.map ? original.split("\n").slice(token.map[0],token.map[1]).join("\n").trim() : "";
            if(authored && !/^[ \t]*>/m.test(authored)) spell(table,"markdown",authored);
            nodes.push(table);
          }
        }
      }
      finish();
      depth--;
      return nodes;
    }
    return read();
  }
  let documentTitle: string | undefined;
  let frontSyntax: Syntax | undefined;
  const front=/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source);
  if(front) {
    const value=front[1]!;
    let valid=true;
    let duplicateKeys=false;
    let metadata: unknown;
    try {
      const yaml=yamlDocument(value,{schema:"core",uniqueKeys:false});
      if(yaml.errors.length) throw new Error(yaml.errors[0]!.message);
      function inspect(node: unknown): void {
        if(!node || typeof node !== "object") return;
        if("tag" in node && node.tag) throw new Error("Explicit YAML tags are unsupported.");
        if(isMap(node)) {
          const keys=new Set<string>();
          for(const pair of node.items) {
            if(!isScalar(pair.key) || typeof pair.key.value !== "string") throw new Error("Metadata keys must be strings.");
            if(keys.has(pair.key.value)) { duplicateKeys=true; warn(options,"duplicate-metadata-key",`Repeated YAML key ${pair.key.value}; the last value wins.`); }
            keys.add(pair.key.value); inspect(pair.value);
          }
        } else if(isSeq(node)) for(const item of node.items) inspect(item);
      }
      inspect(yaml.contents);
      metadata=yaml.toJS({maxAliasCount:100});
      const stack=new Set<unknown>();
      function json(value: unknown): boolean {
        if(value === null || typeof value === "string" || typeof value === "boolean") return true;
        if(typeof value === "number") return Number.isFinite(value);
        if(typeof value !== "object" || stack.has(value)) return false;
        stack.add(value);
        const ok=Array.isArray(value) ? value.every(json) : Object.values(value as object).every(json);
        stack.delete(value); return ok;
      }
      if(metadata === null) metadata={};
      if(!metadata || typeof metadata !== "object" || Array.isArray(metadata) || !json(metadata)) throw new Error("Frontmatter requires JSON-compatible mapping data.");
      const map=metadata as Record<string,Json>;
      if(map.id !== undefined && typeof map.id !== "string") throw new Error("Frontmatter id must be a string.");
      if(map.title !== undefined && typeof map.title !== "string") throw new Error("Frontmatter title must be a string.");
      if(map.description !== undefined && typeof map.description !== "string") throw new Error("Frontmatter description must be a string.");
      if(map.tags !== undefined && (!Array.isArray(map.tags) || !map.tags.every(tag=>typeof tag === "string"))) throw new Error("Frontmatter tags must be a string list.");
      if(map.markdownSyntax !== undefined) {
        if(map.markdownSyntax === "modern" || map.markdownSyntax === "compatible") { frontSyntax=map.markdownSyntax; delete map.markdownSyntax; }
        else warn(options,"invalid-syntax","Frontmatter markdownSyntax must be modern or compatible; it was kept as metadata.");
      }
      if(typeof map.id === "string") { document.id=map.id; delete map.id; }
      if(typeof map.title === "string") { documentTitle=map.title; delete map.title; }
      if(Object.keys(map).length) document.metadata=map;
      // YAML spelling is free-form: keep the authored text unless it resolves a
      // duplicate key. Writers regenerate YAML once the metadata changes.
      if(!duplicateKeys) spell(document,"frontmatter",value);
    } catch(error) { valid=false; warn(options,"invalid-frontmatter",error instanceof Error ? error.message : "Unsupported YAML frontmatter."); }
    frontmatterValid=valid;
    if(!valid) recoveredFrontmatter={type:"literal",display:"block",value:sanitizeHtml(front[0].trimEnd(),options)};
    lineOffset=front[0].split("\n").length-1;
    source=source.slice(front[0].length);
  }
  const syntax: Syntax=frontSyntax ?? options.syntax ?? "compatible";
  if(syntax === "modern") {
    // `modernRules` selects single rules for measurement; documents use them all.
    for(const rule of (options as {modernRules?: readonly ModernRule[]}).modernRules ?? modernRules) modern.add(rule);
    installModern(md,lexicalMd,modern,options);
  }
  if(syntax === "modern" || frontSyntax) document.syntax=syntax;
  document.body=normalizeTabs(blocks(md.parse(source,env),source));
  if(documentTitle !== undefined) document.title=compact({type:"title"},inline(documentTitle));
  const notes=footnoteDefinitions(document);
  if(notes.size) {
    const used=new Set(referenceOrder(document,notes));
    for(const label of notes.keys()) if(!used.has(label)) warn(options,"unused-footnote",`Footnote [^${label}] is never referenced.`);
  }
  if(recoveredFrontmatter) {
    document.body.unshift(recoveredFrontmatter);
    positions.set(recoveredFrontmatter,{start:{line:1,column:1},end:{line:lineOffset,column:1}});
  }
  clearAutomatic(document);
  // A fence longer than the writer's own is a spelling; an equal one is not.
  // Returns the length the writer gives a container, or its deepest nested one.
  // The same walk fingerprints each recorded raw spelling.
  const fences=(node: Node): number => {
    if(typeof node.title === "object" && node.title !== null) fences(node.title);
    let nested=0;
    for(const child of node.body ?? node.children ?? []) nested=Math.max(nested,fences(child));
    rememberSpellings(node);
    if(!["container","table"].includes(node.type)) return nested;
    const own=Math.max(3,nested+1);
    const recorded=node.source?.fence;
    if(typeof recorded !== "number") return own;
    if(recorded <= own) { const {fence: _fence,...rest}=node.source!; if(Object.keys(rest).length) node.source=rest; else delete node.source; return own; }
    return recorded;
  };
  if(spelled) fences(document);
  // CommonMark's HTML blocks can split an element, so stray end tags are found across the document.
  if(!modern.has("html")) {
    const values: string[]=[];
    const collect=(node: Node): void => { if(node.type === "html" && node.value) values.push(node.value); for(const child of node.body ?? node.children ?? []) collect(child); };
    collect(document);
    for(const stray of normalizeTags(values.join("")).strays) warn(options,"stray-end-tag",`${stray} closes no open element; it is ignored.`);
  }
  diagnoseIds(document,options);
  if(options.lint) lint(document,positions,options);
  recordSource(document,markdown,positions,lineOffset,frontmatterValid,options);
  return document;
}

/**
 * Record what writing an unedited document back byte for byte needs: its
 * source text, and each top-level block's range in it with a hash of the
 * block's data. Blocks whose source shares lines form one range. A writer
 * replays a range while its blocks still hash the same.
 */
function recordSource(document: Document, text: string, positions: WeakMap<Node,Position>, headLines: number, head: boolean, options: ConversionOptions): void {
  const starts=[0], ends: number[]=[];
  for(let index=0;index<text.length;index++) {
    const code=text.charCodeAt(index);
    if(code === 10 || code === 13) { ends.push(index); if(code === 13 && text.charCodeAt(index+1) === 10) index++; starts.push(index+1); }
  }
  ends.push(text.length);
  const hashes=contentHashes(document.body);
  // Where tags appear, which marks blocks holding HTML the safe profile may filter.
  const tags: number[]=[];
  for(const match of text.matchAll(/<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>])|<!--|<\?|<![A-Za-z]/g)) tags.push(match.index);
  let tag=0;
  const range=(node: Node): [number,number] | undefined => {
    const position=positions.get(node);
    if(position) return [position.start.line-1,position.end.line];
    const inner=(node.body ?? []).map(range);
    return inner.length && inner.every(Boolean) ? [inner[0]![0],inner.at(-1)![1]] : undefined;
  };
  // Each entry: block count, hash, source range, and 1 when its source holds HTML.
  const blocks: [number,string,number,number,number][]=[];
  let group: {at: number; count: number; from: number; to: number} | undefined;
  const close=()=>{
    if(!group) return;
    // Trailing blank lines are spacing, which belongs between blocks.
    while(group.to-1>group.from && !text.slice(starts[group.to-1],ends[group.to-1]).trim()) group.to--;
    const from=starts[group.from]!, to=ends[group.to-1]!;
    // A tag anywhere in the block, code included, marks HTML the safe profile may filter.
    while(tag<tags.length && tags[tag]!<from) tag++;
    const html=tag<tags.length && tags[tag]!<to ? 1:0;
    blocks.push([group.count,hashes.slice(group.at,group.at+group.count).join("+"),from,to,html]);
  };
  for(const [index,node] of document.body.entries()) {
    const lines=range(node);
    if(!lines || lines[1]<=lines[0] || lines[1]>ends.length) return;
    if(group && lines[0]<group.to) { group.count++; group.to=Math.max(group.to,lines[1]); continue; }
    close();
    group={at:index,count:1,from:lines[0],to:lines[1]};
  }
  close();
  for(let index=1;index<blocks.length;index++) if(blocks[index]![2]<blocks[index-1]![3]) return;
  document.source={...document.source,text,blocks,
    ...(head ? {head:[contentHash([document.id,document.title,document.metadata,document.syntax]),starts[headLines] ?? text.length]} : {}),
    ...(options.trustedHtml ? {trusted:true} : {})};
}

function splitRow(line: string): string[] {
  let source=line.trim();
  if(source.startsWith("|")) source=source.slice(1);
  if(source.endsWith("|") && !source.endsWith("\\|")) source=source.slice(0,-1);
  const cells:string[]=[]; let cell="";
  for(let i=0;i<source.length;i++) {
    if(source[i] === "\\" && i+1<source.length) {cell+=source.slice(i,i+2);i++;continue;}
    if(source[i] === "|") {cells.push(cell);cell="";} else cell+=source[i];
  }
  cells.push(cell);return cells;
}
