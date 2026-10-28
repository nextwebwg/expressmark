import { Engine, type StateBlock, type StateInline, type Token } from "./markdown/engine.js";
import { parseDocument as yamlDocument, isMap, isSeq, isScalar } from "yaml";
import { footnoteDefinitions, referenceOrder } from "./references.js";
import { alertMarker, attach, childHashes, compact, contentHash, destination, plainText, quoteAttribute, readInfo, rememberSpellings, writeAttributes, structuralTypes, diagnoseIds, mentionBoundary, readAttributes, readHeader, readLabel, tokenHandle, tokenIdentifier } from "./grammar.js";
import { escapeHtml, htmlNodes, normalizeTags, parentEndCloses, readStartTag, sanitizeFragment, sanitizeStartTag, sanitizeHtml, sanitizeLiteral, TagStack, unmatchedTags, voidElements } from "./html.js";
import { mergeTable, readListTable, readTableField } from "./tables.js";
import { installStandard, standardRules, type StandardRule } from "./standard.js";
import type { ConversionOptions, Document, Json, Node, Position, Syntax } from "./types.js";
import { linting, validateSyntax, warn } from "./types.js";
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
// The rules Expressive Markdown adds to the reader. A reader is built once per
// rule set; each rule runs the parse's own implementation, found in `env`.
type BlockHook = (state: StateBlock, start: number, end: number, silent: boolean) => boolean;
type InlineHook = (state: StateInline, silent: boolean) => boolean;
interface Hooks {
  expressive_line_code: InlineHook; expressive: InlineHook; expressive_attachment: InlineHook; newline: InlineHook; link: InlineHook; image: InlineHook;
  bracketed_span: InlineHook; footnote_reference: InlineHook;
  footnote_definition: BlockHook; reference: BlockHook; expressive_container: BlockHook; expressive_leaf: BlockHook; expressive_line_block: BlockHook;
}
interface Readers { md: Engine; lexicalMd: Engine; originals: { reference: BlockHook; newline: InlineHook; link: InlineHook; image: InlineHook } }
const hooksOf = (state: {env: Record<string,unknown>}) => state.env.hooks as Hooks;
const readerCache=new Map<string,Readers>();
function readers(standard: ReadonlySet<StandardRule>): Readers {
  const key=[...standard].sort().join(",");
  const cached=readerCache.get(key);
  if(cached) return cached;
  const md=new Engine("default",{html:true,linkify:true});
  const lexicalMd=new Engine("default",{html:true});
  const originals={reference:md.block.ruler.get("reference").fn,newline:md.inline.ruler.get("newline").fn,link:md.inline.ruler.get("link").fn,image:md.inline.ruler.get("image").fn};
  const inlineHook=(name: keyof Hooks): InlineHook => (state,silent) => (hooksOf(state)[name] as InlineHook)(state,silent);
  const blockHook=(name: keyof Hooks): BlockHook => (state,start,end,silent) => (hooksOf(state)[name] as BlockHook)(state,start,end,silent);
  const blocks=["paragraph","reference","blockquote","list"];
  md.inline.ruler.before("backticks","expressive_line_code",inlineHook("expressive_line_code"));
  md.inline.ruler.before("emphasis","expressive",inlineHook("expressive"));
  md.inline.ruler.after("expressive","expressive_attachment",inlineHook("expressive_attachment"));
  md.block.ruler.before("reference","footnote_definition",blockHook("footnote_definition"),{alt:["paragraph","reference"]});
  md.block.ruler.at("reference",blockHook("reference"));
  md.core.ruler.disable("strip_references");
  md.inline.ruler.at("newline",inlineHook("newline"));
  md.inline.ruler.at("link",inlineHook("link"));
  md.inline.ruler.at("image",inlineHook("image"));
  md.inline.ruler.after("link","bracketed_span",inlineHook("bracketed_span"));
  md.inline.ruler.before("link","footnote_reference",inlineHook("footnote_reference"));
  md.block.ruler.before("fence","expressive_container",blockHook("expressive_container"),{alt:blocks});
  md.block.ruler.before("paragraph","expressive_leaf",blockHook("expressive_leaf"),{alt:blocks});
  md.block.ruler.before("paragraph","expressive_line_block",blockHook("expressive_line_block"),{alt:blocks});
  if(standard.size) installStandard(md,lexicalMd,standard);
  const built={md,lexicalMd,originals};
  readerCache.set(key,built);
  return built;
}
/** A top-level block: its source lines, after any frontmatter, and the nodes it made. */
interface Top { start: number; end: number; nodes: Node[]; definitions?: boolean }
/** What a parse leaves for reading an edit of its document. */
interface Session {
  markdown: string; source: string; front: string;
  /** Undefined when an edit re-reads the whole document. */
  tops: Top[] | undefined;
  references: Record<string,{href:string;title:string}> | undefined;
  footnotes: readonly string[];
  positions: WeakMap<Node,Position>;
  itemLines: WeakMap<Node,[number,number][]>;
}
interface Edit { session: Session; from: number; to: number; text: string }

// Whether blocks hold a link or footnote definition at any depth.
function definitionsOf(nodes: readonly Node[]): boolean {
  const visit=(node: Node): boolean => node.type === "definition" || node.type === "footnoteDefinition" || (node.body ?? node.children ?? []).some(visit);
  return nodes.some(visit);
}
const topDefinitions=(top: Top) => top.definitions ??= definitionsOf(top.nodes);

export function parse(markdown: string, options: ConversionOptions = {}): Document {
  return read(markdown,options).document;
}

/** A parsed document that reads an edit by re-reading only the blocks it changes. */
export interface MarkdownDoc {
  /** The document, as `parse` reads `text`. Read it; an edit reuses its unchanged nodes. */
  readonly document: Document;
  readonly text: string;
  /** The document with `text.slice(from, to)` replaced by `replacement`. */
  edit(from: number, to: number, replacement: string): MarkdownDoc;
}

/**
 * Parse `markdown` for editing. Each edit re-reads from the top-level block
 * before it until the blocks after it start where they started before, and
 * reuses every other block's nodes; its document equals `parse` of the edited
 * text. An edit re-reads the whole document when it changes the frontmatter or
 * the link and footnote definitions, when the text holds a carriage return or
 * a byte order mark, and with `lint` or `onDiagnostic`, whose findings span
 * the document.
 */
export function parseDoc(markdown: string, options: ConversionOptions = {}): MarkdownDoc {
  return markdownDoc(read(markdown,options,undefined,true),options);
}
function markdownDoc({document,session}: {document: Document; session?: Session}, options: ConversionOptions): MarkdownDoc {
  const current=session!;
  return {document,text:current.markdown,edit(from,to,replacement) {
    if(!Number.isInteger(from) || !Number.isInteger(to) || from<0 || to<from || to>current.markdown.length) throw new RangeError(`An edit's range must lie within the text: ${from} to ${to}.`);
    if(typeof replacement !== "string") throw new TypeError("An edit's replacement must be a string.");
    const next=current.markdown.slice(0,from)+replacement+current.markdown.slice(to);
    const reuse=current.tops !== undefined && !options.lint && !options.onDiagnostic && !/[\r\uFEFF]/.test(replacement);
    return markdownDoc(read(next,options,reuse ? {session:current,from,to,text:replacement} : undefined,true),options);
  }};
}

function read(markdown: string, options: ConversionOptions, edit?: Edit, keep = false): {document: Document; session?: Session} {
  validateSyntax(options.syntax);
  spelled=false;
  if (typeof markdown !== "string") throw new TypeError("Markdown must be a string.");
  const document: Document = {type:"document",version:1,body:[]};
  // The `standard` rules in force, known once the frontmatter is read.
  const standard=new Set<StandardRule>();
  // Lint warnings report the source lines of the block holding each construct.
  const positions=new WeakMap<Node,Position>();
  let lineOffset=0;
  // The readers for the document's rules, chosen once the frontmatter is read.
  let md: Engine, lexicalMd: Engine, originals: Readers["originals"];
  const hooks={} as Hooks;
  // Per block state: table cells parse their own sources.
  const lexicalRanges=new WeakMap<StateBlock,Map<string,{from:number;ranges:Map<number,number>}>>();
  // Definition labels, collected by the block pass before any inline content is read.
  const footnotes=new Set<string>();
  const defined=new Set<string>();
  const env: Record<string,unknown> = {hooks,options};
  const tasks=new WeakMap<Node,RegExpExecArray>();
  // A top-level list's items' source lines, for writing an edited list back item by item.
  const itemLines=new WeakMap<Node,[number,number][]>();
  let source = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  if(source.includes("\r")) source=source.replace(/\r\n?/g,"\n");
  // Top-level blocks, recorded while reading `topSource` from line `topBase`.
  const tops: Top[]=[];
  let topBase=0, topSource=source, restartable=keep && !/[\r\uFEFF]/.test(markdown);
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
  hooks.expressive_line_code=(state,silent)=> {
    if(!lineMode || state.src[state.pos] !== "`") return false;
    const ticks=/^`+/.exec(state.src.slice(state.pos))![0];
    const close=state.src.indexOf(ticks,state.pos+ticks.length);
    if(close<0 || !state.src.slice(state.pos+ticks.length,close).includes("\n")) return false;
    if(!silent) state.push("text","",0).content=ticks;
    state.pos+=ticks.length; return true;
  };
  hooks.expressive=(state,silent) => {
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
  };
  hooks.expressive_attachment=(state,silent) => {
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
  };
  hooks.footnote_definition=(state,start,end,silent) => {
    if(state.sCount[start]! - state.blkIndent >= 4) return false;
    const begin=state.bMarks[start]!+state.tShift[start]!;
    const match=/^\[\^([^\]]*)\]:/.exec(state.src.slice(begin,state.eMarks[start]));
    if(!match || tokenHandle(match[1]!) !== match[1]) return false;
    if(silent) return true;
    footnotes.add(match[1]!);
    const opened=state.push("footnote_open","",1); opened.meta={label:match[1]}; const lines: [number,number]=[start,start+1]; opened.map=lines;
    // Read the note like a list item: its first line starts after the marker,
    // and its continuation lines are indented four columns past the marker, or
    // in `standard` syntax, past the marker by any amount, as list nesting is.
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
    state.blkIndent=standard.has("relativeLists") ? saved.sCount+1 : outer+4;
    state.parentType="footnote" as typeof state.parentType;
    if(state.sCount[start]! < state.blkIndent) state.sCount[start]!+=state.blkIndent;
    state.md.block.tokenize(state,start,end);
    lines[1]=state.line;
    state.parentType=saved.parentType;
    state.blkIndent=outer;
    state.tShift[start]=saved.tShift; state.sCount[start]=saved.sCount; state.bMarks[start]=saved.bMark;
    state.push("footnote_close","",-1);
    return true;
  };
  // Reference definitions and reference links keep their authored form. Wrap
  // the reader's own rules so CommonMark decides what matches; then record it.
  hooks.reference=(state,start,end,silent) => {
    const env=state.env as {references?: Record<string,{href:string;title:string}>};
    const outer=env.references ?? {};
    // A fresh table reveals this definition's values even when an earlier one
    // already owns the label; the first definition still wins for resolution.
    const own: NonNullable<typeof env.references>={};
    env.references=own;
    let matched: boolean;
    try { matched=originals.reference(state,start,end,silent); } finally { env.references=outer; }
    if(!matched || silent) return matched;
    const [key,value]=Object.entries(own)[0]!;
    // The reader's own token keeps only the normalized label; record the authored one.
    const raw=/^\[((?:\\[\s\S]|[^\\[\]])*)\]:/.exec(state.getLines(start,state.line,state.blkIndent,false).trimStart())!;
    if(key in outer) {
      warn(options,"duplicate-definition",`Link reference [${raw[1]}] is defined more than once; the ${standard.has("lastDefinition") ? "last":"first"} definition is used.`);
      if(standard.has("lastDefinition")) outer[key]=value;
    } else outer[key]=value;
    state.tokens.at(-1)!.meta={label:raw[1],url:value.href,title:value.title,markdown:state.getLines(start,state.line,state.blkIndent,false).trim()};
    return true;
  };
  hooks.newline=(state,silent) => {
    // Trailing spaces spell a hard break as well as a backslash does.
    let spaces=0;
    if(state.src[state.pos] === "\n") while(state.pending[state.pending.length-1-spaces] === " ") spaces++;
    const count=state.tokens.length;
    if(!originals.newline(state,silent)) return false;
    const token=state.tokens.slice(count).find(candidate=>candidate.type === "hardbreak");
    if(token && spaces >= 2) token.meta={spaces};
    return true;
  };
  for(const [name,offset] of [["link",0],["image",1]] as const) {
    hooks[name]=(state,silent) => {
      const rule=originals[name];
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
    };
  }
  // `[text]{attributes}` is a bracketed span when the bracket is no link. It
  // runs after the link rule, so links and resolving references keep their
  // lists; `![…]` stays image syntax and `[^…]` footnote syntax.
  hooks.bracketed_span=(state,silent) => {
    // Link-label scans see the bracket as text; a span forms when the link's
    // own content is parsed, so a span may sit inside link text.
    if(silent || state.src[state.pos] !== "[" || state.src[state.pos+1] === "^") return false;
    // A bracket after an unescaped `!`, `@` or `:name` has the image, mention or
    // inline-type shape, and one right after `]` belongs to a reference's form;
    // when that construct does not form, its source stays text.
    const shape=/(\\*)(?:[!@\]]|:[A-Za-z][A-Za-z0-9_-]*)$/.exec(state.src.slice(Math.max(0,state.pos-64),state.pos));
    if(shape && shape[1]!.length%2 === 0) return false;
    const label=readLabel(state.src.slice(state.pos)); if(!label) return false;
    const attributesStart=state.pos+label.length;
    let cursor=attributesStart;
    const lists: NonNullable<ReturnType<typeof readAttributes>>[]=[];
    while(state.src[cursor] === "{") { const attrs=readAttributes(state.src.slice(cursor),silent ? {}:options); if(!attrs) break; lists.push(attrs); cursor+=attrs.length; }
    if(!lists.length) return false;
    if(!silent) {
      const node=compact({type:"inline"},inline(label.value));
      for(const attrs of lists) attach(node,attrs);
      const authored=state.src.slice(attributesStart,cursor);
      if(authored !== writeAttributes(node)) spell(node,"attributes",authored);
      state.push("expressive_inline","",0).meta={node};
    }
    state.pos=cursor;
    return true;
  };
  hooks.footnote_reference=(state,silent) => {
    if(state.src[state.pos] !== "[" || state.src[state.pos+1] !== "^") return false;
    const label=tokenHandle(state.src.slice(state.pos+2));
    if(!label || state.src[state.pos+2+label.length] !== "]") return false;
    // An undefined reference stays text, as an unresolved link reference does.
    if(!footnotes.has(label)) { if(!silent) warn(options,"undefined-footnote",`Footnote [^${label}] has no definition; it remains text.`); return false; }
    if(!silent) { const token=state.push("footnote_ref","",0); token.meta={label}; token.content=`[^${label}]`; }
    state.pos+=label.length+3;
    return true;
  };
  hooks.expressive_container=(state,start,end,silent) => {
    if(state.sCount[start]! - state.blkIndent >= 4) return false;
    const opening=/^(:{3,})(.*)$/.exec(line(state,start)); if(!opening) return false;
    // Every colon fence opens a container. A header that cannot be read gives
    // a generic container keeping the raw header, so writing restores it.
    // The header keeps its spacing after the colons.
    const header=opening[2]!.trimEnd();
    const parsed=readHeader(opening[2]!,silent ? {}:options,true);
    // An unreadable header keeps the type it names; `source.rest` keeps what follows.
    const named=parsed ? undefined : tokenIdentifier(header.trimStart());
    const node: Node=parsed ?? (named && named.toLowerCase() !== "table" ? {type:"container",subType:named.toLowerCase(),body:[]} : {type:"container",body:[]});
    const label=typeof node.title === "object" ? node.title.value : undefined;
    const parts=[node.subType,label === undefined ? undefined : node.titleSpelling === "unbracketed" ? label : `[${label}]`,writeAttributes(node)].filter(Boolean).join(" ");
    if(!parsed) spell(node,"rest",node.subType ? header.trimStart().slice(named!.length) : header);
    else if(header !== (parts ? ` ${parts}`:"")) spell(node,"header",header);
    if(!parsed && !silent) warn(options,"invalid-container-header",`The container header "${header.trim()}" could not be read; it is kept as written.`);
    spell(node,"fence",opening[1]!.length);
    if(silent) return true;
    const length=opening[1]!.length;
    // A container ends with its enclosing block, such as a list item: its last
    // line comes before the first nonblank line indented less than that block.
    if(state.blkIndent>0) for(let index=start+1;index<end;index++) if(!state.isEmpty(index) && state.sCount[index]!<state.blkIndent) { end=index; break; }
    const bare=!header.trim();
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
      const fieldCode=fieldValue === undefined ? undefined:/^(`{3,}|~{3,})(.*)$/.exec(fieldValue);
      // A backtick fence cannot have backticks in its info string. In particular,
      // a field starting with a code span must not hide the table's closing line.
      if(fieldCode?.[1]?.[0] === "`" && fieldCode[2]!.includes("`")) continue;
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
      // A bare fence's closing line must come before another opening fence of
      // its length or longer; otherwise that line closes the other container.
      const opener=bare ? /^(:{3,})[ \t]*\S/.exec(text) : null;
      if(opener && opener[1]!.length >= length) { close=end; break; }
    }
    const closed=close < end && new RegExp(`^:{${length}}[ \\t]*$`).test(line(state,close));
    if(!closed && bare) {
      // A stray bare fence is one line: kept so it round-trips, rendering nothing.
      const stray=state.push("stray_fence","",0); stray.content=line(state,start).trim(); stray.map=[start,start+1];
      warn(options,"stray-fence","A bare colon fence has no closing line; it is kept as a stray fence.");
      state.line=start+1; return true;
    }
    if(!closed) warn(options,"unclosed-container","A container has no closing line; it runs to the end of its enclosing block.");
    const after=closed ? close+1 : close;
    if(node.subType === "table") {
      const body=state.getLines(start+1,close,state.blkIndent,false);
      const table=state.push("expressive_table","",0); table.meta={node,body,source:state.getLines(start,after,state.blkIndent,false).trimEnd()}; table.map=[start,after];
      state.line=after; return true;
    }
    const token=state.push("expressive_container_open","",1); token.meta={node}; token.map=[start,after];
    const oldParent=state.parentType;
    state.parentType="container";
    // Like a code fence's, a fence's own indentation leaves each enclosed line.
    const indent=state.sCount[start]!-state.blkIndent;
    const saved: [number,number,number,number][]=[];
    if(indent>0) for(let index=start+1;index<close;index++) {
      const spaces=/^ */.exec(state.src.slice(state.bMarks[index]!,state.bMarks[index]!+indent))![0].length;
      const strip=Math.min(spaces,indent,state.tShift[index]!);
      if(!strip) continue;
      saved.push([index,state.bMarks[index]!,state.tShift[index]!,state.sCount[index]!]);
      state.bMarks[index]!+=strip; state.tShift[index]!-=strip; state.sCount[index]!-=strip;
    }
    state.md.block.tokenize(state,start+1,close);
    for(const [index,bMark,tShift,sCount] of saved) { state.bMarks[index]=bMark; state.tShift[index]=tShift; state.sCount[index]=sCount; }
    state.parentType=oldParent;
    state.push("expressive_container_close","",-1);
    state.line=after; return true;
  };
  hooks.expressive_leaf=(state,start,_end,silent) => {
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
  };
  hooks.expressive_line_block=(state,start,end,silent) => {
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
  };

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
  // A `standard` HTML tag within inline content, matched as HTML matches tags.
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
        } else if(token.type === "html_inline" && standard.has("html")) { const found=inlineElement(tokens,cursor-1,lineBlock); nodes.push(...found.nodes); cursor=found.next; }
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
    // The source's lines, split once: a document's tables would otherwise split it once each.
    const lines=()=>sourceLines ??= original.split("\n");
    const lineAt=(index: number)=>lines()[index] ?? "";
    // The block nodes a token made take its source lines, for lint positions.
    const place=(nodes: Node[], at: number, map: [number,number] | null | undefined)=> {
      if(!map || original !== topSource) return;
      // Only lint reports the end column, which reading the source's lines gives.
      for(const node of nodes.slice(at)) if(!positions.has(node)) positions.set(node,{start:{line:map[0]+topBase+lineOffset+1,column:1},end:{line:map[1]+topBase+lineOffset,column:options.lint ? lineAt(map[1]-1).length+1 : 1}});
    };
    // Top-level blocks always take their lines, for writing them back exactly.
    let depth=0;
    function read(until?:string): Node[] {
      depth++;
      const nodes: Node[]=[];
      let made: {at: number; map: [number,number] | null} | undefined;
      const finish=()=>{
        if(!made) return;
        // A block that makes no node, such as filtered HTML, still holds its lines.
        if(depth === 1 && keep && original === topSource) {
          if(made.map) tops.push({start:made.map[0]+topBase,end:made.map[1]+topBase,nodes:nodes.slice(made.at)});
          else if(nodes.length>made.at) restartable=false;
        }
        if(options.lint || depth === 1) place(nodes,made.at,made.map);
      };
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
          // A `standard` list splits at a blank line, so only its items can be loose.
          node.tight=standard.has("looseLists") || !loose;
          // Lint: indentation that mixes tabs and spaces, between items or within one.
          if(options.lint && !standard.has("relativeLists") && original === topSource && linting(options.lint,"mixed-indentation")) {
            const lead=(index: number)=>/^[ \t]*/.exec(lineAt(index))![0];
            const unrelated=(a: string, b: string)=>!a.startsWith(b) && !b.startsWith(a);
            const items=tokens.slice(listStart,cursor).filter(item=>item.type === "list_item_open" && item.level === token.level+1 && item.map);
            const first=items[0] ? lead(items[0].map![0]) : "";
            if(items.some(item=>unrelated(lead(item.map![0]),first) || Array.from({length:item.map![1]-item.map![0]-1},(_,offset)=>item.map![0]+1+offset).some(index=>lineAt(index).trim() && unrelated(lead(index),lead(item.map![0])))))
              warn(options,"mixed-indentation","A list mixes tabs and spaces in its indentation; tabs count to the next multiple of four columns.");
          }
          if(token.markup !== (node.ordered ? ".":"-")) spell(node,"marker",token.markup);
          if(node.ordered && items>1 && same) spell(node,"numbering","same");
          if(depth === 1 && original === topSource) {
            const ranges: [number,number][]=[];
            for(let index=listStart;index<cursor;index++) {
              const item=tokens[index]!;
              if(item.type === "list_item_open" && item.level === token.level+1 && item.map) ranges.push([item.map[0]+topBase+lineOffset,item.map[1]+topBase+lineOffset]);
            }
            if(ranges.length === node.children!.length) itemLines.set(node,ranges);
          }
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
            if(task) {
              node.checked=task[1]!.toLowerCase() === "x";
              if(task[1] === "X") spell(node,"marker","X");
              if(first.value !== undefined) first.value=first.value.slice(task[0].length);
              else {
                // The marker leaves no empty text node before the item's content.
                const rest=text!.slice(task[0].length);
                if(rest) first.children![0]!.value=rest; else first.children!.shift();
              }
            }
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
          const table=readListTable(meta.node,meta.body,value=>md.parse(value,{hooks,options}),value=>blocks(md.parse(value,env),value));
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
        else if(token.type === "stray_fence") nodes.push({type:"strayFence",value:token.content});
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
          // The reader reports physical CSS values for GFM markers; the public AST uses logical directions.
          const alignment=rows[0]?.children?.map((_cell,index)=> {
            const first=tokens.slice(start,cursor).filter(t=>t.type === "th_open")[index];
            const style=String(first?.attrGet("style") ?? ""); return style?.includes("center") ? "center" : style?.includes("right") ? "end" : style?.includes("left") ? "start" : null;
          }) ?? [];
          const table: Node={type:"table",children:rows};
          if(alignment.some(Boolean)) table.align=alignment;
          const originalRows=token.map ? lines().slice(token.map[0],token.map[1]).filter((_row,index)=>index !== 1).map(splitRow) : rawCells;
          const hasMerges=originalRows.some(row=>row.some(cell=>/^[>^]$/.test(cell.trim())));
          // Lint: `\|` in a cell's code span, which `standard` syntax keeps as written.
          if(token.map && original === topSource && !standard.has("tableCode") && linting(options.lint,"table-code-pipe") && /`[^`\n]*\\\|[^`\n]*`/.test(lines().slice(token.map[0],token.map[1]).join("\n")))
            options.onDiagnostic?.({code:"table-code-pipe",message:"A code span in this table writes \\| for a pipe; in standard syntax the backslash shows, so write |.",severity:"warning",preferred:"| inside the code span",position:{start:{line:token.map[0]+lineOffset+1,column:1},end:{line:token.map[1]+lineOffset,column:lineAt(token.map[1]-1).length+1}}});
          const invalid=hasMerges && originalRows.some(row=>row.length !== (rows[0]?.children?.length ?? 0)) ? "Merged tables require every authored row to supply the same column count." : mergeTable(table,rawCells);
          if(invalid) {
            const range=token.map;
            const value=range ? lines().slice(range[0],range[1]).join("\n") : rawCells.map(row=>`| ${row.join(" | ")} |`).join("\n");
            nodes.push({type:"literal",display:"block",value:sanitizeHtml(value,options)});
            warn(options,"invalid-table-merge",invalid);
          } else {
            // Pipe source is a second table spelling; its padding is part of it.
            spell(table,"form","pipe");
            // Inside a quote the lines carry its markers; the canonical pipe form applies there.
            const authored=token.map ? lines().slice(token.map[0],token.map[1]).join("\n").trim() : "";
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
        if(map.markdownSyntax === "standard" || map.markdownSyntax === "compatible") { frontSyntax=map.markdownSyntax; delete map.markdownSyntax; }
        else warn(options,"invalid-syntax","Frontmatter markdownSyntax must be standard or compatible; it was kept as metadata.");
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
  const syntax: Syntax=frontSyntax ?? options.syntax ?? "standard";
  if(syntax === "standard") {
    // `standardRules` selects single rules for measurement; documents use them all.
    for(const rule of (options as {standardRules?: readonly StandardRule[]}).standardRules ?? standardRules) standard.add(rule);
  }
  ({md,lexicalMd,originals}=readers(standard));
  if(syntax === "compatible" || frontSyntax) document.syntax=syntax;
  const isTab=(node: Node)=>node.type === "container" && node.subType === "tab";
  // Re-read the blocks an edit changes and reuse the rest, or read them all.
  function reread({session,from,to,text}: Edit): Node[] | undefined {
    const head=front?.[0] ?? "";
    if(!session.tops || head !== session.front || from<head.length) return;
    const lineOf=(value: string, offset: number)=>{ let line=0; for(let at=value.indexOf("\n");at >= 0 && at<offset;at=value.indexOf("\n",at+1)) line++; return line; };
    const editLine=lineOf(session.source,from-head.length), oldLast=lineOf(session.source,to-head.length), newLast=lineOf(source,from-head.length+text.length), delta=newLast-oldLast;
    // `standard` syntax reads an element through its end tag wherever that is,
    // so a block before an edit can depend on the tags an edit changes: an edit
    // that adds or removes tag text, falls on a line holding a tag, or lands
    // inside a tag re-reads everything.
    if(standard.has("html")) {
      const lineSpan=(value: string, at: number, end: number)=>value.slice(value.lastIndexOf("\n",at-1)+1,(value.indexOf("\n",end)+1 || value.length+1)-1);
      const prior=session.markdown, removed=prior.slice(from,to);
      if(/[<>]/.test(removed+text) || lineSpan(prior,from,to).includes("<") || lineSpan(markdown,from,from+text.length).includes("<") || prior.lastIndexOf("<",from)>prior.lastIndexOf(">",from)) return;
    }
    // A block's reading saw its lines and the line after them, so the first
    // block reaching the edited line is where reading restarts.
    const old=session.tops;
    let first=old.findIndex(top=>top.end >= editLine);
    if(first<0) first=old.length;
    const restart=Math.min(first<old.length ? old[first]!.start : editLine,editLine);
    let offset=0;
    for(let line=0;line<restart;line++) offset=source.indexOf("\n",offset)+1;
    // Reading stops at the first block after the edit that starts where a block started before.
    const starts=new Map<number,number>();
    // Tokens from one block share its lines; resuming starts at the block's first.
    old.forEach((top,index)=>{ if(top.start>oldLast && !starts.has(top.start)) starts.set(top.start,index); });
    let resume=old.length, stopped=-1;
    const stop=(line: number)=>{
      const at=restart+line;
      const index=at>newLast ? starts.get(at-delta) : undefined;
      if(index === undefined) return false;
      resume=index; stopped=at; return true;
    };
    // Reading usually stops within a few blocks of the edit, so the first read
    // takes the text through the fourth block after it. A block's reading sees
    // only its lines and the next, so a stop before that text's last line reads
    // as it would in the whole text; otherwise the read takes the rest.
    const next=old.findIndex(top=>top.start>oldLast);
    const bound=next >= 0 && next+4<old.length ? old[next+4]!.start+delta : -1;
    let end=source.length;
    if(bound>restart) { end=offset; for(let line=restart;line<bound && end >= 0;line++) end=source.indexOf("\n",end)+1 || -1; if(end <= 0) end=source.length; }
    let region: string, tokens: Token[];
    for(;;) {
      // The previous reading's definitions; the check below confirms they hold.
      env.references={...session.references};
      footnotes.clear(); for(const label of session.footnotes) footnotes.add(label);
      resume=old.length; stopped=-1;
      region=source.slice(offset,end);
      tokens=md.parse(region,env,stop);
      if(end === source.length || stopped >= 0 && stopped<bound) break;
      end=source.length;
    }
    topBase=restart; topSource=region;
    const raw=blocks(tokens,region);
    if(!restartable || raw.some(isTab)) return;
    // Every block's inline content reads against the document's definitions:
    // re-read blocks that hold or held one, at any depth, re-read everything.
    const before=old.slice(0,first), after=old.slice(resume);
    if(old.slice(first,resume).some(top=>topDefinitions(top)) || definitionsOf(raw)) return;
    const nodes=normalizeTabs(raw);
    const shift=(position: Position): Position=>({start:{...position.start,line:position.start.line+delta},end:{...position.end,line:position.end.line+delta}});
    for(const top of before) for(const node of top.nodes) {
      const position=session.positions.get(node); if(position) positions.set(node,position);
      const items=session.itemLines.get(node); if(items) itemLines.set(node,items);
    }
    const moved=after.map(top=>{
      for(const node of top.nodes) {
        const position=session.positions.get(node); if(position) positions.set(node,shift(position));
        const items=session.itemLines.get(node); if(items) itemLines.set(node,items.map(([a,b])=>[a+delta,b+delta]));
      }
      return {...top,start:top.start+delta,end:top.end+delta};
    });
    tops.unshift(...before); tops.push(...moved);
    document.body=[...before.flatMap(top=>top.nodes),...nodes,...after.flatMap(top=>top.nodes)];
    return nodes;
  }
  let fresh=edit && restartable ? reread(edit) : undefined;
  const incremental=fresh !== undefined;
  if(!fresh) {
    // A full reading starts from a clean slate.
    tops.length=0; topBase=0; topSource=source; delete env.references; footnotes.clear(); defined.clear();
    restartable=keep && !/[\r\uFEFF]/.test(markdown);
    const raw=blocks(md.parse(source,env),source);
    if(raw.some(isTab)) restartable=false;
    fresh=document.body=normalizeTabs(raw);
  }
  if(documentTitle !== undefined) document.title=compact({type:"title"},inline(documentTitle));
  // Warnings span the document, and are only read through `onDiagnostic`.
  const notes=options.onDiagnostic ? footnoteDefinitions(document) : new Map<string,Node>();
  if(notes.size) {
    const used=new Set(referenceOrder(document,notes));
    for(const label of notes.keys()) if(!used.has(label)) warn(options,"unused-footnote",`Footnote [^${label}] is never referenced.`);
  }
  if(recoveredFrontmatter) {
    document.body.unshift(recoveredFrontmatter);
    positions.set(recoveredFrontmatter,{start:{line:1,column:1},end:{line:lineOffset,column:1}});
    if(incremental) fresh=[recoveredFrontmatter,...fresh];
  }
  // The passes below leave a block as they found it once they have seen it,
  // so after an edit they visit only the blocks it re-read.
  if(incremental) fresh.forEach(clearAutomatic); else clearAutomatic(document);
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
  if(spelled && incremental) {
    if(typeof document.title === "object" && document.title !== null) fences(document.title);
    fresh.forEach(fences); rememberSpellings(document);
  } else if(spelled) fences(document);
  // CommonMark's HTML blocks can split an element, so stray end tags are found across the document.
  if(!standard.has("html") && options.onDiagnostic) {
    const values: string[]=[];
    const collect=(node: Node): void => { if(node.type === "html" && node.value) values.push(node.value); for(const child of node.body ?? node.children ?? []) collect(child); };
    collect(document);
    for(const stray of normalizeTags(values.join("")).strays) warn(options,"stray-end-tag",`${stray} closes no open element; it is ignored.`);
  }
  if(options.onDiagnostic) diagnoseIds(document,options);
  if(options.lint) lint(document,positions,options);
  recordSource(document,markdown,positions,itemLines,lineOffset,frontmatterValid,options,keep);
  if(!keep) return {document};
  return {document,session:{markdown,source,front:front?.[0] ?? "",tops:restartable ? tops : undefined,references:env.references as Session["references"],footnotes:[...footnotes],positions,itemLines}};
}

// A node's hash as its source record holds it. A document parsed for editing
// hashes the nodes it made once, and an edit reuses the hashes of the nodes it
// reuses.
const hashes=new WeakMap<Node,string>();
function recordedHash(node: Node): string {
  let hash=hashes.get(node);
  if(hash === undefined) { hash=contentHash(node); hashes.set(node,hash); }
  return hash;
}

/**
 * Record what writing an unedited document back byte for byte needs: its
 * source text, and each top-level block's range in it with a hash of the
 * block's data. Blocks whose source shares lines form one range. A writer
 * replays a range while its blocks still hash the same. A range holding one
 * list also records each item's range and hash, with a hash of the list apart
 * from its items, so a writer replays the items an edit leaves alone.
 */
function recordSource(document: Document, text: string, positions: WeakMap<Node,Position>, itemLines: WeakMap<Node,[number,number][]>, headLines: number, head: boolean, options: ConversionOptions, keep: boolean): void {
  const hashOf=keep ? recordedHash : contentHash;
  const starts=[0], ends: number[]=[];
  if(text.includes("\r")) for(let index=0;index<text.length;index++) {
    const code=text.charCodeAt(index);
    if(code === 10 || code === 13) { ends.push(index); if(code === 13 && text.charCodeAt(index+1) === 10) index++; starts.push(index+1); }
  } else for(let index=text.indexOf("\n");index >= 0;index=text.indexOf("\n",index+1)) { ends.push(index); starts.push(index+1); }
  ends.push(text.length);
  // A list's items are hashed with it, each serialized once.
  const listed=new Map<Node,string[]>();
  const blockHashes=document.body.map(node=>{
    if(node.type !== "list" || !itemLines.has(node) || keep && hashes.has(node)) return hashOf(node);
    const {hash,children}=childHashes(node);
    listed.set(node,children);
    if(keep) { hashes.set(node,hash); node.children!.forEach((item,index)=>hashes.set(item,children[index]!)); }
    return hash;
  });
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
  // Each entry: block count, hash, source range, 1 when its source holds HTML,
  // and for one list, the list's hash apart from its items followed by each
  // item's hash and source range.
  const blocks: ([number,string,number,number,number] | [number,string,number,number,number,(string | number)[]])[]=[];
  // A line range's offsets, without the blank lines that end it.
  const offsets=(from: number, to: number): [number,number] => {
    while(to-1>from && !text.slice(starts[to-1],ends[to-1]).trim()) to--;
    return [starts[from]!,ends[to-1]!];
  };
  let group: {at: number; count: number; from: number; to: number} | undefined;
  const close=()=>{
    if(!group) return;
    // Trailing blank lines are spacing, which belongs between blocks.
    const [from,to]=offsets(group.from,group.to);
    // A tag anywhere in the block, code included, marks HTML the safe profile may filter.
    while(tag<tags.length && tags[tag]!<from) tag++;
    const html=tag<tags.length && tags[tag]!<to ? 1:0;
    const node=document.body[group.at]!, items=group.count === 1 ? itemLines.get(node) : undefined;
    if(items && items.every(([first,last])=>last>first && last<=ends.length)) {
      const parts: (string | number)[]=[contentHash({...node,children:[]})];
      const each=listed.get(node);
      node.children!.forEach((item,index)=>parts.push(each?.[index] ?? hashOf(item),...offsets(items[index]![0],items[index]![1])));
      blocks.push([group.count,blockHashes[group.at]!,from,to,html,parts]);
    } else blocks.push([group.count,blockHashes.slice(group.at,group.at+group.count).join("+"),from,to,html]);
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
