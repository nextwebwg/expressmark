import MarkdownIt, { type Token, type StateBlock, type StateInline } from "markdown-it";
import { parseDocument as yamlDocument, isMap, isSeq, isScalar } from "yaml";
import { configureAutolinks } from "./autolinks.js";
import { footnoteDefinitions, referenceOrder } from "./references.js";
import { alertMarker, attach, compact, destination, quoteAttribute, readInfo, rememberSpellings, writeAttributes, structuralTypes, diagnoseIds, mentionBoundary, readAttributes, readHeader, readLabel, tokenHandle, tokenIdentifier } from "./grammar.js";
import { htmlNodes, sanitizeHtml, sanitizeLiteral } from "./html.js";
import { mergeTable, readListTable, readTableField } from "./tables.js";
import type { ConversionOptions, Document, Json, Node } from "./types.js";
import { warn } from "./types.js";

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
  const md = new MarkdownIt({html:true,linkify:true,typographer:false});
  configureAutolinks(md);
  // Definition labels, collected by the block pass before any inline content is read.
  const footnotes=new Set<string>();
  const defined=new Set<string>();
  const env: Record<string,unknown> = {};
  const tasks=new WeakMap<Node,RegExpExecArray>();
  let source = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g,"\n");
  let recoveredFrontmatter: Node | undefined;

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
    if(silent) return true;
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
    if(silent) return true;
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
    state.push("footnote_open","",1).meta={label:match[1]};
    // Read the note like a list item: its first line starts after the marker,
    // and its continuation lines are indented four columns past the marker.
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
    state.blkIndent+=4;
    state.parentType="footnote" as typeof state.parentType;
    if(state.sCount[start]! < state.blkIndent) state.sCount[start]!+=state.blkIndent;
    state.md.block.tokenize(state,start,end);
    state.parentType=saved.parentType;
    state.blkIndent-=4;
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
    if(!(key in outer)) outer[key]=value;
    // markdown-it's own token keeps only the normalized label; record the authored one.
    const raw=/^\[((?:\\[\s\S]|[^\\[\]])*)\]:/.exec(state.getLines(start,state.line,state.blkIndent,false).trimStart())!;
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
    let close=start+1;
    let code: {mark:string;length:number}|undefined;
    // Let CommonMark locate code/HTML in list and quote contexts too. Jump at
    // a token's opening line so a named field's inline fence can take priority.
    const lexical=new MarkdownIt({html:true}).parse(state.getLines(start+1,end,state.blkIndent,false),{});
    const literalRanges=new Map<number,number>();
    for(const token of lexical) if(["fence","code_block","html_block"].includes(token.type) && token.map) literalRanges.set(start+1+token.map[0],start+1+token.map[1]);
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
      token.content=sanitizeHtml(state.getLines(start,end,state.blkIndent,false),options);
      warn(options,"unclosed-container","An unclosed or mismatched container is preserved as literal source.");
      state.line=end; return true;
    }
    if(node.subType === "table") {
      const body=state.getLines(start+1,close,state.blkIndent,false);
      state.push("expressive_table","",0).meta={node,body,source:state.getLines(start,close+1,state.blkIndent,false).trimEnd()};
      state.line=close+1; return true;
    }
    const token=state.push("expressive_container_open","",1); token.meta={node};
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
    state.push("expressive_leaf","",0).meta={node};
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
        } else if(token.type === "html_inline" && options.trustedHtml) nodes.push({type:"html",display:"inline",value:token.content});
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
                  node.value=node.value.replace(marker,inner.map(child=>child.value ?? "").join(""));
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
    function read(until?:string): Node[] {
      const nodes: Node[]=[];
      while(cursor<tokens.length) {
        const token=tokens[cursor++]!;
        if(token.type === until) break;
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
          node.tight=!loose;
          if(token.markup !== (node.ordered ? ".":"-")) spell(node,"marker",token.markup);
          if(node.ordered && items>1 && same) spell(node,"numbering","same");
          nodes.push(node);
        } else if(token.type === "list_item_open") {
          const body=read("list_item_close");
          const node: Node={type:"listItem",body};
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
        else if(token.type === "html_block") nodes.push(...(options.trustedHtml ? [{type:"html",display:"block" as const,value:token.content.trimEnd()}] : htmlNodes(token.content.trimEnd(),"block",options)));
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
          if(authored && authored !== `[${node.label}]: ${destination(node.url!)}${node.title ? ` ${quoteAttribute(node.title as string)}`:""}`) spell(node,"markdown",authored);
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
      return nodes;
    }
    return read();
  }
  let documentTitle: string | undefined;
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
      if(typeof map.id === "string") { document.id=map.id; delete map.id; }
      if(typeof map.title === "string") { documentTitle=map.title; delete map.title; }
      if(Object.keys(map).length) document.metadata=map;
      // YAML spelling is free-form: keep the authored text unless it resolves a
      // duplicate key. Writers regenerate YAML once the metadata changes.
      if(!duplicateKeys) spell(document,"frontmatter",value);
    } catch(error) { valid=false; warn(options,"invalid-frontmatter",error instanceof Error ? error.message : "Unsupported YAML frontmatter."); }
    if(!valid) recoveredFrontmatter={type:"literal",display:"block",value:sanitizeHtml(front[0].trimEnd(),options)};
    source=source.slice(front[0].length);
  }
  document.body=normalizeTabs(blocks(md.parse(source,env),source));
  if(documentTitle !== undefined) document.title=compact({type:"title"},inline(documentTitle));
  const notes=footnoteDefinitions(document);
  if(notes.size) {
    const used=new Set(referenceOrder(document,notes));
    for(const label of notes.keys()) if(!used.has(label)) warn(options,"unused-footnote",`Footnote [^${label}] is never referenced.`);
  }
  if(recoveredFrontmatter) document.body.unshift(recoveredFrontmatter);
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
  diagnoseIds(document,options);
  return document;
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
