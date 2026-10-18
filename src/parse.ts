import MarkdownIt, { type Token, type StateBlock, type StateInline } from "markdown-it";
import { parseDocument as yamlDocument, isMap, isSeq, isScalar } from "yaml";
import { attach, compact, diagnoseIds, readAttributes, readHeader, readLabel, tokenHandle, tokenIdentifier } from "./grammar.js";
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

export function parse(markdown: string, options: ConversionOptions = {}): Document {
  if (typeof markdown !== "string") throw new TypeError("Markdown must be a string.");
  const document: Document = {type:"document",version:1,body:[]};
  const md = new MarkdownIt({html:true,linkify:true,typographer:false});
  // GFM recognizes www-prefixed links, while linkify-it leaves fuzzy URLs off.
  // Reuse its HTTP boundary rules without also linking arbitrary bare domains.
  md.linkify.add("www.", {
    validate(text,position,self) {
      const length=self.testSchemaAt(`//www.${text.slice(position)}`,"http:",0);
      return length>6 ? length-6:0;
    },
    normalize(match) { match.url=`http://${match.raw}`; },
  });
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
    if(marker === "@") {
      if (/[\p{L}\p{M}\p{N}_\-./@]/u.test(state.src[start-1] ?? "")) return false;
      subtype="mention";
      if(state.src[cursor] === "[") {
        const found=readLabel(state.src.slice(cursor)); if(!found) return false;
        label=found.value; cursor+=found.length;
      } else {
        const found=tokenHandle(state.src.slice(cursor)); if(!found) return false;
        label=found; cursor+=found.length;
      }
      if(state.src[cursor] === "#") {
        ref=tokenHandle(state.src.slice(cursor+1)); if(ref) cursor+=ref.length+1;
      }
    } else {
      const found=tokenIdentifier(state.src.slice(cursor)); if(!found) return false;
      subtype=found.toLowerCase(); cursor+=found.length;
      if(state.src[cursor] === "[") {
        const bracket=readLabel(state.src.slice(cursor)); if(!bracket) return false;
        label=bracket.value; cursor+=bracket.length;
      }
    }
    const node: Node={type:"inline",subType:subtype};
    if(ref !== undefined) node.ref=ref;
    let attached=false;
    while(state.src[cursor] === "{") {
      const attrs=readAttributes(state.src.slice(cursor),options); if(!attrs) break;
      attach(node,attrs); cursor+=attrs.length; attached=true;
    }
    if(label === undefined && !attached) return false;
    if(silent) return true;
    if(label !== undefined) compact(node,inline(label));
    promote(node);
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
    state.pos+=attrs.length;
    return true;
  });
  md.block.ruler.before("fence","expressive_container",(state,start,end,silent) => {
    if(state.sCount[start]! - state.blkIndent >= 4) return false;
    const opening=/^(:{3,})(.*)$/.exec(line(state,start)); if(!opening) return false;
    const node=readHeader(opening[2]!,options); if(!node) return false;
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
    title(node);
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
    node.type="leaf"; delete node.body; title(node);
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
    state.line=cursor; return true;
  },{alt:["paragraph","reference","blockquote","list"]});

  function inlineTokens(tokens: Token[], lineBlock = false): Node[] {
    let cursor=0;
    function read(until?:string): Node[] {
      const nodes: Node[]=[];
      while(cursor<tokens.length) {
        const token=tokens[cursor++]!;
        if(token.type === until) break;
        if(token.type === "text") nodes.push({type:"text",value:token.content});
        else if(token.type === "expressive_inline") nodes.push(token.meta!.node as Node);
        else if(token.type === "softbreak" || token.type === "hardbreak") nodes.push({type:token.type === "hardbreak" || lineBlock ? "break":"softBreak"});
        else if(token.type === "code_inline") nodes.push({type:"inlineCode",value:token.content});
        else if(token.type === "image") {
          const node: Node={type:"image",url:String(token.attrGet("src") ?? ""),alt:token.children ? token.children.map(t=>t.content).join("") : token.content};
          const tooltip=token.attrGet("title"); if(tooltip !== null) node.title=String(tooltip);
          for(const attrs of ((token.meta?.attributes ?? []) as NonNullable<ReturnType<typeof readAttributes>>[])) attach(node,attrs);
          nodes.push(node);
        } else if(token.type === "link_open") {
          const node=compact({type:"link",url:String(token.attrGet("href") ?? "")},read("link_close"));
          const tooltip=token.attrGet("title"); if(tooltip !== null) node.title=String(tooltip);
          for(const attrs of ((tokens[cursor-1]?.meta?.attributes ?? []) as NonNullable<ReturnType<typeof readAttributes>>[])) attach(node,attrs);
          nodes.push(node);
        } else if(["em_open","strong_open","s_open"].includes(token.type)) {
          const type=token.type === "em_open" ? "emphasis" : token.type === "s_open" ? "delete":"strong";
          nodes.push(compact({type},read(token.type.replace("_open","_close"))));
        } else if(token.type === "html_inline") {
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
    function read(until?:string): Node[] {
      const nodes: Node[]=[];
      while(cursor<tokens.length) {
        const token=tokens[cursor++]!;
        if(token.type === until) break;
        if(token.type === "paragraph_open" || token.type === "heading_open") {
          const inner=tokens[cursor++]!;
          let content=inner.content;
          const attached: NonNullable<ReturnType<typeof readAttributes>>[]=[];
          if(token.type === "heading_open") {
            // Find a complete, whitespace-separated trailing attribute sequence.
            for(let i=0;i<content.length;i++) if(content[i] === "{" && /\s/.test(content[i-1] ?? "")) {
              let position=i; const candidates: typeof attached=[];
              while(position<content.length) {
                const attrs=readAttributes(content.slice(position),options); if(!attrs) break;
                candidates.push(attrs); position+=attrs.length;
                position+=/^[ \t]*/.exec(content.slice(position))![0].length;
              }
              if(position === content.length && candidates.length) { attached.push(...candidates); content=content.slice(0,i).trimEnd(); break; }
            }
          }
          const node=compact(token.type === "paragraph_open" ? {type:"paragraph"} : {type:"heading",level:Number(token.tag.slice(1))},inline(content));
          for(const attrs of attached) attach(node,attrs);
          if(token.type === "paragraph_open") { const task=/^\[([ xX])\][ \t]+/.exec(content); if(task) tasks.set(node,task); }
          cursor++; nodes.push(node);
        } else if(token.type === "blockquote_open") nodes.push({type:"blockquote",body:read("blockquote_close")});
        else if(token.type === "bullet_list_open" || token.type === "ordered_list_open") {
          const listStart=cursor;
          const node: Node={type:"list",ordered:token.type === "ordered_list_open",tight:true,children:read(token.type.replace("_open","_close"))};
          const start=token.attrGet("start"); if(start !== null && Number(start) !== 1) node.start=Number(start);
          // Only direct item paragraphs determine this list's tightness.
          node.tight=!tokens.slice(listStart,cursor).some(t=>t.type === "paragraph_open" && t.level === token.level+2 && !t.hidden);
          nodes.push(node);
        } else if(token.type === "list_item_open") {
          const body=read("list_item_close");
          const node: Node={type:"listItem",body};
          const first=body[0];
          if(first?.type === "paragraph") {
            const text=first.value ?? (first.children?.[0]?.type === "text" ? first.children[0].value : undefined);
            const task=tasks.get(first);
            if(task) { node.checked=task[1]!.toLowerCase() === "x"; if(first.value !== undefined) first.value=first.value.slice(task[0].length); else first.children![0]!.value=text!.slice(task[0].length); }
          }
          nodes.push(node);
        } else if(token.type === "fence" || token.type === "code_block") {
          const node: Node={type:"code",value:""};
          // One parser-added terminal LF is removed; authored trailing blank lines remain.
          node.value=token.content.endsWith("\n") ? token.content.slice(0,-1) : token.content;
          let info=token.info.trim();
          const language=/^[^\s{]+/.exec(info);
          if(language) { node.language=language[0]; info=info.slice(language[0].length).trimStart(); }
          let rest="";
          while(info) {
            const attrs=readAttributes(info,options);
            if(attrs) { attach(node,attrs); info=info.slice(attrs.length).trimStart(); }
            else { const match=/^[^\s]+/.exec(info)!; rest+=`${rest ? " ":""}${match[0]}`; info=info.slice(match[0].length).trimStart(); }
          }
          if(rest) node.meta=rest;
          promote(node); nodes.push(node);
        } else if(token.type === "hr") nodes.push({type:"horizontalRule"});
        else if(token.type === "html_block") nodes.push(...htmlNodes(token.content.trimEnd(),"block",options));
        else if(token.type === "expressive_container_open") {
          const node=token.meta!.node as Node; node.body=read("expressive_container_close"); nodes.push(node);
        } else if(token.type === "expressive_table") {
          // Convert after the document block pass has collected link references.
          const meta=token.meta as {node:Node;body:string;source:string};
          const table=readListTable(meta.node,meta.body,md,value=>blocks(md.parse(value,env),value));
          if(typeof table === "string") {
            nodes.push({type:"literal",display:"block",value:sanitizeLiteral(meta.source,options)});
            warn(options,"invalid-table",table);
          } else nodes.push(table);
        }
        else if(token.type === "expressive_leaf") nodes.push(token.meta!.node as Node);
        else if(token.type === "expressive_literal") nodes.push({type:"literal",display:"block",value:token.content});
        else if(token.type === "expressive_line_block") nodes.push(compact({type:"lineBlock"},inline(token.content,true)));
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
          const alignment=rows[0]?.children?.map((_cell,index)=> {
            const first=tokens.slice(start,cursor).filter(t=>t.type === "th_open")[index];
            const style=String(first?.attrGet("style") ?? ""); return style?.includes("center") ? "center" : style?.includes("right") ? "right" : style?.includes("left") ? "left" : null;
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
          } else nodes.push(table);
        }
      }
      return nodes;
    }
    return read();
  }
  const front=/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source);
  if(front) {
    const value=front[1]!;
    let valid=true;
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
            if(keys.has(pair.key.value)) warn(options,"duplicate-metadata-key",`Repeated YAML key ${pair.key.value}; the last value wins.`);
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
      if(typeof map.title === "string") { document.title=compact({type:"title"},inline(map.title)); delete map.title; }
      if(Object.keys(map).length) document.metadata=map;
    } catch(error) { valid=false; warn(options,"invalid-frontmatter",error instanceof Error ? error.message : "Unsupported YAML frontmatter."); }
    if(!valid) recoveredFrontmatter={type:"literal",display:"block",value:sanitizeHtml(front[0].trimEnd(),options)};
    source=source.slice(front[0].length);
  }
  document.body=normalizeTabs(blocks(md.parse(source,env),source));
  if(recoveredFrontmatter) document.body.unshift(recoveredFrontmatter);
  clearAutomatic(document);
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
