import { stringify as yamlStringify } from "yaml";
import { escapeText, startsMention, type TextContext } from "./escape.js";
import { diagnoseIds, normalizeLabel, quoteAttribute, sourceKey, tokenHandle, writeAttributes } from "./grammar.js";
import { escapeHtml, safeAuthoredAttributes, safeUrl, sanitizeHtml, sanitizeLiteral } from "./html.js";
import { footnoteDefinitions, linkDefinitions } from "./references.js";
import { tableGrid, transposeTable } from "./tables.js";
import type { Attributes, ConversionOptions, Document, Node } from "./types.js";
import { ConversionError, warn } from "./types.js";

function fail(message: string): never { throw new ConversionError("unsupported-conversion",message); }
function inlineCode(value: string): string {
  const length=Math.max(0,...Array.from(value.matchAll(/`+/g),m=>m[0].length))+1;
  const fence="`".repeat(length);
  const padding=/^`|`$/.test(value) || (/^ | $/.test(value) && /[^ ]/.test(value)) ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}
// Destinations keep backslashes and angle brackets literal, and use <…> when needed.
function destination(value: string): string {
  const url=value.replace(/\\/g,"\\\\").replace(/[<>\n]/g,c=>encodeURIComponent(c));
  return !url || /[\s()\\]/u.test(url) ? `<${url}>`:url;
}
function attrsHtml(node: Node, extra: Record<string,string|boolean|number> = {}): string {
  const values: Record<string,string|boolean|number>={...node.attributes,...extra};
  if(node.id !== undefined) values.id=node.id;
  const native = new Set(["id","class","style","title","lang","dir","href","name","target","rel","src","alt","width","height","loading","open","start","value","colspan","rowspan","scope","headers"]);
  const output=Object.entries(values).filter(([,value])=>value !== false).map(([key,value])=> {
    let name=sourceKey(key);
    if(!native.has(name) && !name.startsWith("data-") && !name.startsWith("aria-")) name=`data-${name}`;
    return ` ${name}="${value === true ? "" : escapeHtml(String(value))}"`;
  });
  if(node.attributes && Object.keys(node.attributes).length) output.push(` data-attributes="${escapeHtml(JSON.stringify(safeAuthoredAttributes(node.attributes,{})))}"`);
  return output.join("");
}
function validate(node: Node, path = "document", seen = new Set<Node>()): void {
  if(!node || typeof node !== "object" || typeof node.type !== "string" || !node.type) fail(`${path} needs a nonempty node type.`);
  if(seen.has(node)) fail(`${path} contains a cyclic node reference.`);
  seen.add(node);
  if([node.body,node.children,node.value].filter(value=>value !== undefined && value !== null).length>1) fail(`${path} cannot combine body, children and value.`);
  if(node.value !== undefined && node.value !== null && typeof node.value !== "string") fail(`${path}.value must be a string.`);
  if(node.id !== undefined && node.id !== null && typeof node.id !== "string") fail(`${path}.id must be a string.`);
  for(const [key,value] of Object.entries(node.attributes ?? {})) {
    if(!/^[a-zA-Z][\w]*$/.test(key) || typeof value !== "string" && typeof value !== "boolean" || typeof value === "string" && /[\r\n]/.test(value)) fail(`${path} has an unsupported attribute ${key}.`);
  }
  for(const slot of ["body","children"] as const) if(node[slot] !== undefined && node[slot] !== null) {
    if(!Array.isArray(node[slot])) fail(`${path}.${slot} must be an array.`);
    for(const [i,child] of node[slot].entries()) validate(child,`${path}.${slot}[${i}]`,seen);
  }
  if(node.title !== undefined && node.title !== null && typeof node.title !== "string") validate(node.title,`${path}.title`,seen);
  const known=new Set(["type","subType","id","title","body","children","value","attributes","position","source","data","level","ordered","start","tight","checked","url","alt","language","meta","ref","label","referenceType","align","header","colSpan","rowSpan","display","tag","version","metadata"]);
  for(const key of Object.keys(node)) if(!known.has(key)) fail(`${path}.${key} has no Markdown mapping.`);
  const structural: Record<string,string[]> = {
    document:["version","metadata"], footnoteReference:["label"], footnoteDefinition:["label"],
    definition:["label","url"], linkReference:["label","referenceType"], imageReference:["label","referenceType","alt"], heading:["level"], list:["ordered","start","tight"], listItem:["checked"],
    link:["url"],image:["url","alt"],code:["language","meta"], inline:["ref"],table:["align"],tableCell:["header","colSpan","rowSpan"],group:["display","tag"],html:["display"],literal:["display"],
  };
  for(const key of ["ordered","tight","checked","header"] as const) if(node[key] !== undefined && typeof node[key] !== "boolean") fail(`${path}.${key} must be a boolean.`);
  for(const key of ["url","alt","language","meta","ref","subType"] as const) if(node[key] !== undefined && typeof node[key] !== "string") fail(`${path}.${key} must be a string.`);
  for(const key of ["level","start","colSpan","rowSpan"] as const) if(node[key] !== undefined && (!Number.isInteger(node[key]) || node[key]! < (key === "start" ? 0:1))) fail(`${path}.${key} has an invalid integer value.`);
  if(node.align !== undefined && (!Array.isArray(node.align) || node.align.some(value=>value !== null && !["start","center","end"].includes(value)))) fail(`${path}.align needs column alignment values.`);
  if(node.type === "group" && !Array.isArray(node.children)) fail(`${path} needs structural children.`);
  const special=["level","ordered","start","tight","checked","url","alt","language","meta","ref","label","referenceType","align","header","colSpan","rowSpan","display","tag","version","metadata"];
  for(const key of special) if(key in node && !structural[node.type]?.includes(key)) fail(`${path}.${key} is not defined for ${node.type}.`);
  if(node.subType !== undefined && !["container","inline","leaf"].includes(node.type)) fail(`${path}.subType is not defined for ${node.type}.`);
  if(node.ref !== undefined && node.subType !== "mention") fail(`${path}.ref is only defined for mentions.`);
  if(["document","container","blockquote","listItem","footnoteDefinition"].includes(node.type) && !Array.isArray(node.body)) fail(`${path} needs a block body.`);
  if(["footnoteReference","footnoteDefinition"].includes(node.type)) {
    if(typeof node.label !== "string" || tokenHandle(node.label) !== node.label) fail(`${path}.label needs a footnote label.`);
    if(node.id !== undefined || node.attributes) fail(`${path} has no footnote attribute source mapping.`);
  }
  if(["list","table","tableRow"].includes(node.type) && !Array.isArray(node.children)) fail(`${path} needs structural children.`);
  if(["paragraph","heading","title","emphasis","strong","delete","underline","highlight","lineBlock","link","linkReference","tableCell"].includes(node.type) && node.value == null && node.children == null && !(node.type === "tableCell" && node.body)) fail(`${path} needs content.`);
  if(["text","inlineCode","code","html","literal"].includes(node.type) && typeof node.value !== "string") fail(`${path} needs literal value content.`);
  if(["definition","linkReference","imageReference"].includes(node.type)) {
    // A label is CommonMark link-label text: unescaped brackets close it early.
    if(typeof node.label !== "string" || !/^(?:\\[\s\S]|[^\\[\]])+$/.test(node.label) || !node.label.trim() || /\n[ \t]*\n/.test(node.label) || node.label.length>999) fail(`${path}.label needs a link label.`);
    if(node.type !== "definition" && !["full","collapsed","shortcut"].includes(node.referenceType ?? "")) fail(`${path}.referenceType needs full, collapsed or shortcut.`);
    if(node.type === "definition" && (node.id !== undefined || node.attributes)) fail(`${path} has no definition attribute source mapping.`);
  }
  if(["image","break","softBreak","horizontalRule","leaf","footnoteReference","definition","imageReference"].includes(node.type) && [node.value,node.children,node.body].some(value=>value != null)) fail(`${path} is bodyless.`);
  if(node.title != null && !["document","container","table","code","link","image","leaf","definition"].includes(node.type)) fail(`${path} does not define a title.`);
  if(["code","link","image","definition"].includes(node.type) && node.title != null && typeof node.title !== "string") fail(`${path}.title must be a string.`);
  if(["document","container","table","leaf"].includes(node.type) && node.title != null && (typeof node.title !== "object" || node.title.type !== "title")) fail(`${path}.title must be a title node.`);
  const inlineTypes=new Set(["text","emphasis","strong","delete","underline","highlight","inlineCode","break","softBreak","link","image","inline","footnoteReference","linkReference","imageReference"]);
  const blockTypes=new Set(["paragraph","heading","blockquote","list","code","lineBlock","table","container","leaf","horizontalRule","footnoteDefinition","definition"]);
  const isInline=(child:Node)=>inlineTypes.has(child.type) || ["group","html","literal"].includes(child.type) && child.display === "inline";
  const isBlock=(child:Node)=>blockTypes.has(child.type) || ["group","html","literal"].includes(child.type) && child.display === "block";
  if(node.body?.some(child=>!isBlock(child))) fail(`${path}.body needs block nodes.`);
  if(node.children && !["list","table","tableRow","group"].includes(node.type) && node.children.some(child=>!isInline(child))) fail(`${path}.children needs inline nodes.`);
  if(["link","image","definition"].includes(node.type) && typeof node.url !== "string") fail(`${path} needs a string URL.`);
  if(["image","imageReference"].includes(node.type) && typeof node.alt !== "string") fail(`${path} needs string alternative text.`);
  if(node.type === "lineBlock" && node.value?.includes("\n")) fail(`${path} cannot store represented line boundaries in a literal value.`);
  if(node.type === "group" && !["inline","block"].includes(node.display ?? "")) fail(`${path} needs inline or block display.`);
  if(node.type === "group" && node.tag !== undefined && node.tag !== (node.display === "inline" ? "span":"div")) fail(`${path} native tag conflicts with its display.`);
  if(["link","linkReference"].includes(node.type) && node.children?.some(child=>["link","linkReference"].includes(child.type))) fail(`${path} cannot contain nested links.`);
  if(node.type === "tableRow" && node.children?.some(child=>child.type !== "tableCell")) fail(`${path} needs tableCell children.`);
  seen.delete(node);
}

function normalizeAbsence(node: Node, seen=new Set<Node>()): Node {
  if(!node || typeof node !== "object") fail("Expected a document node.");
  if(seen.has(node)) fail("A document cannot contain cyclic content.");
  seen.add(node);
  const copy={...node};
  for(const key of Object.keys(copy) as (keyof Node)[]) if(copy[key] === null) delete copy[key];
  for(const key of ["body","children"] as const) if(Array.isArray(copy[key])) copy[key]=copy[key].map(child=>normalizeAbsence(child,seen));
  if(typeof copy.title === "object" && copy.title !== null) copy.title=normalizeAbsence(copy.title,seen);
  seen.delete(node);return copy;
}
function validateMetadata(value: unknown, ancestors=new Set<unknown>()): void {
  if(value === null || typeof value === "string" || typeof value === "boolean") return;
  if(typeof value === "number" && Number.isFinite(value)) return;
  if(!value || typeof value !== "object" || ancestors.has(value)) fail("Metadata must contain finite, acyclic JSON values.");
  const prototype=Object.getPrototypeOf(value);
  if(!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) fail("Metadata requires plain JSON objects.");
  ancestors.add(value);
  for(const child of Object.values(value)) validateMetadata(child,ancestors);
  ancestors.delete(value);
}

export function stringify(document: Document, options: ConversionOptions = {}): string {
  document=normalizeAbsence(document) as Document;
  if(document?.type !== "document" || document.version !== 1 || !Array.isArray(document.body)) throw new ConversionError("unsupported-version","Expected a document with version 1 and a body array.");
  validate(document);
  if(document.metadata !== undefined) {
    if(!document.metadata || typeof document.metadata !== "object" || Array.isArray(document.metadata)) fail("Document metadata must be a JSON mapping.");
    validateMetadata(document.metadata);
    const metadata=document.metadata;
    if(metadata.description !== undefined && typeof metadata.description !== "string") fail("Metadata description must be a string.");
    if(metadata.tags !== undefined && (!Array.isArray(metadata.tags) || metadata.tags.some(tag=>typeof tag !== "string"))) fail("Metadata tags must be a list of strings.");
    if(Object.hasOwn(metadata,"id") && document.id === undefined) fail("metadata.id has no independent source mapping; use the document id field.");
    if(Object.hasOwn(metadata,"title") && document.title === undefined) fail("metadata.title has no independent source mapping; use the document title field.");
  }
  diagnoseIds(document,options);
  const footnotes=new Set(footnoteDefinitions(document).keys());
  const definitions=linkDefinitions(document);
  const references=new Set(definitions.keys());
  function content(node: Node, context: TextContext = {}): string {
    // Adjacent unstyled text has no source boundary. Escape its combined text
    // so split URL/directive prefixes cannot acquire meaning during writing.
    const children: Node[]=[];
    for(const child of node.children ?? []) {
      const previous=children.at(-1);
      if(child.type === "text" && !writeAttributes(child) && previous?.type === "text" && !writeAttributes(previous)) {
        children[children.length-1]={...previous,value:previous.value!+child.value!};
      } else children.push(child);
    }
    const textContext: TextContext={...context,footnotes,references,block:["paragraph","tableCell"].includes(node.type),heading:node.type === "heading"};
    return node.value !== undefined ? escapeText(node.value,textContext) : children.map((child,index)=>inline(child,children[index-1],children[index+1],textContext)).join("");
  }
  function caption(node: Node): string {
    if(typeof node.title === "object" && node.title !== null && (node.title.id !== undefined || node.title.attributes || ["container","leaf"].includes(node.type) && /[\r\n]|^[ \t]|[ \t]$/.test(content(node.title)))) fail("A title's own attributes have no bracket-title source mapping.");
    const context: TextContext={block:false,label:node.type !== "document"};
    return typeof node.title === "object" && node.title !== null ? content(node.title,context) : typeof node.title === "string" ? escapeText(node.title,context) : ""; }
  function native(node: Node): string {
    const wrapper=(tag:string,value:string,extra:Record<string,string|boolean|number> = {}) => `<${tag}${attrsHtml(node,extra)}>${value}</${tag}>`;
    const kids=()=>node.value !== undefined ? escapeHtml(node.value) : (node.children ?? []).map(native).join("");
    if(node.type === "text") return escapeHtml(node.value ?? "");
    if(node.type === "paragraph") return wrapper("p",kids());
    if(node.type === "heading") return wrapper(`h${node.level}`,kids());
    if(node.type === "title") return kids();
    const tags:Record<string,string>={strong:"strong",emphasis:"em",delete:"s",underline:"u",highlight:"mark",inlineCode:"code"};
    if(tags[node.type]) return wrapper(tags[node.type]!,kids());
    if(node.type === "break" || node.type === "horizontalRule") return `<${node.type === "break" ? "br":"hr"}${attrsHtml(node)}>`;
    if(node.type === "softBreak") return "\n";
    if(node.type === "image") return `<img${attrsHtml(node,{src:node.url ?? "",alt:node.alt ?? "",...(typeof node.title === "string" ? {title:node.title}:{})})}>`;
    if(node.type === "link") return wrapper("a",kids(),{href:node.url ?? "",...(typeof node.title === "string" ? {title:node.title}:{})});
    if(node.type === "inline") return wrapper("span",kids(),{"data-type":node.subType ?? "",...(node.ref !== undefined ? {"data-ref":node.ref}:{})});
    if(node.type === "container" && !["details","figure"].includes(node.subType ?? "")) {
      const heading=node.title ? `<header>${typeof node.title === "object" ? native(node.title):escapeHtml(node.title)}</header>`:"";
      return wrapper("section",`${heading}${(node.body ?? []).map(native).join("")}`,{"data-type":node.subType ?? ""});
    }
    if(node.type === "group") return wrapper(node.tag ?? (node.display === "inline" ? "span":"div"),(node.children ?? []).map(native).join(""));
    if(node.type === "blockquote") return wrapper("blockquote",(node.body ?? []).map(native).join(""));
    if(node.type === "list") return wrapper(node.ordered ? "ol":"ul",(node.children ?? []).map(native).join(""),node.start !== undefined ? {start:node.start}:{});
    if(node.type === "listItem") {
      if(node.checked !== undefined) fail("A styled task-list item has no lossless safe HTML mapping.");
      return wrapper("li",(node.body ?? []).map(native).join(""));
    }
    if(node.type === "code") {
      if(node.title !== undefined || node.meta !== undefined) fail("Styled native code with a caption or uninterpreted metadata is unsupported.");
      return wrapper("pre",`<code${node.language ? ` class="language-${escapeHtml(node.language)}"`:""}>${escapeHtml(node.value ?? "")}</code>`);
    }
    if(node.type === "container" && ["details","figure"].includes(node.subType ?? "")) {
      const tag=node.subType!;
      const heading=node.title ? `<${tag === "details" ? "summary":"figcaption"}>${typeof node.title === "object" ? native(node.title):escapeHtml(node.title)}</${tag === "details" ? "summary":"figcaption"}>` : "";
      return wrapper(tag,`${tag === "details" ? heading:""}${(node.body ?? []).map(native).join("")}${tag === "figure" ? heading:""}`);
    }
    if(node.type === "table") return wrapper("table",`${node.title ? `<caption>${typeof node.title === "object" ? native(node.title):escapeHtml(node.title)}</caption>`:""}${(node.children ?? []).map(native).join("")}`,node.align ? {"data-align":JSON.stringify(node.align)}:{});
    if(node.type === "tableRow") return wrapper("tr",(node.children ?? []).map(native).join(""));
    if(node.type === "tableCell") return wrapper(node.header ? "th":"td",node.body ? node.body.map(native).join("") : kids(),{...(node.colSpan ? {colspan:node.colSpan}:{}),...(node.rowSpan ? {rowspan:node.rowSpan}:{})});
    if(node.type === "html") { if(node.id !== undefined || node.attributes) fail("Opaque HTML node attributes have no independent source mapping."); return sanitizeHtml(node.value ?? "",options); }
    fail(`Node ${node.type} cannot be represented in a native HTML wrapper.`);
  }
  function safeNative(node: Node): string {
    const raw=native(node);
    const clean=sanitizeHtml(raw,options);
    if(clean !== raw) warn(options,"presentation-filtered","Native presentation was normalized or filtered by the safe HTML profile.");
    return clean;
  }
  function inline(node: Node, previous?: Node, next?: Node, context: TextContext = {}): string {
    const attrs=writeAttributes(node);
    if(["link","image"].includes(node.type) && !safeUrl(node.url ?? "",node.type === "image")) {
      warn(options,"unsafe-url","An unsafe link or image URL was removed.");
      return node.type === "image" ? escapeText(node.alt ?? "") : content(node);
    }
    if(node.type === "text") { if(attrs) return safeNative({type:"group",display:"inline",tag:"span",children:[{type:"text",value:node.value ?? ""}],...(node.id !== undefined ? {id:node.id}:{}),...(node.attributes ? {attributes:node.attributes}:{})}); return escapeText(node.value ?? "",{...context,...(previous ? {previous}:{}),...(next ? {next}:{})}); }
    if(["strong","emphasis","delete"].includes(node.type)) {
      const marks=["strong","emphasis","delete"];
      // Delimiter runs can lose padded text or merge adjacent/nested marks.
      // Keep their exact boundaries with the existing semantic HTML mapping.
      if(attrs || node.children?.some(child=>marks.includes(child.type))
        || marks.includes(previous?.type ?? "") || marks.includes(next?.type ?? "")) return safeNative(node);
      const value=content(node,{...context,mentionStart:false,marks:`${context.marks ?? ""}${node.type === "delete" ? "~":"*"}`});
      if(!value || /^\s|\s$/u.test(value)
        || /^[\p{P}\p{S}]/u.test(value) && previous?.type === "text" && /[^\s\p{P}\p{S}]$/u.test(previous.value ?? "")
        || /[\p{P}\p{S}]$/u.test(value) && next?.type === "text" && /^[^\s\p{P}\p{S}]/u.test(next.value ?? "")) return safeNative(node);
      const mark=node.type === "strong" ? "**" : node.type === "emphasis" ? "*":"~~";
      return `${mark}${value}${mark}`;
    }
    if(["underline","highlight","group"].includes(node.type)) return safeNative(node);
    if(node.type === "inlineCode") return attrs ? safeNative(node) : inlineCode(node.value ?? "");
    if(node.type === "break") { if(attrs) return safeNative(node); return "\\\n"; }
    if(node.type === "softBreak") { if(attrs) fail("A soft break cannot carry authored attributes in Markdown."); return "\n"; }
    if(node.type === "link" || node.type === "image") {
      const tooltip=typeof node.title === "string" ? ` ${quoteAttribute(node.title)}` : "";
      const label=node.type === "image" ? escapeText(node.alt ?? "",{block:false,label:true}) : content(node,{label:true,protectAutolinks:false,mentionStart:false});
      return `${node.type === "image" ? "!":""}[${label}](${destination(node.url ?? "")}${tooltip})${attrs}`;
    }
    if(node.type === "linkReference" || node.type === "imageReference") {
      const text=node.type === "imageReference" ? escapeText(node.alt ?? "",{block:false,label:true}) : content(node,{label:true,protectAutolinks:false,mentionStart:false});
      const label=node.label!;
      if(!definitions.has(normalizeLabel(label))) warn(options,"undefined-reference",`Reference [${label}] has no definition; it will read back as text.`);
      // Keep the authored form. Collapsed and shortcut forms name their label
      // with the text, so edited text needs the full form; a shortcut also
      // needs a closing [] when the next characters would extend it.
      let form=node.referenceType!;
      if(form !== "full" && normalizeLabel(text) !== normalizeLabel(label)) form="full";
      const following=next?.type === "text" ? next.value ?? "" : next ? "[" : "";
      if(form === "shortcut" && /^[[(:]/.test(following)) form="collapsed";
      return `${node.type === "imageReference" ? "!":""}[${text}]${form === "full" ? `[${label}]` : form === "collapsed" ? "[]":""}${attrs}`;
    }
    if(node.type === "inline") {
      if(!/^[a-z][a-z0-9_-]*$/.test(node.subType ?? "")) fail("Inline directives need a valid subtype.");
      if(node.subType === "mention") {
        // Markdown cannot spell a mention at a non-whitespace source boundary.
        // Native semantic markup preserves an authored occurrence there without
        // inserting spaces into the document or broadening mention recognition.
        if(!startsMention({...context,...(previous ? {previous}:{})})) return safeNative(node);
        const ref=node.ref;
        const suffix=ref !== undefined && tokenHandle(ref) === ref ? `#${ref}`:"";
        const extra: Attributes=ref !== undefined && !suffix ? {ref}:{};
        return `@[${content(node,{label:true})}]${suffix}${writeAttributes(node,extra)}`;
      }
      return `:${node.subType}${node.value !== undefined || node.children ? `[${content(node,{label:true})}]`:""}${attrs}`;
    }
    if(node.type === "footnoteReference") {
      if(!footnotes.has(node.label!)) warn(options,"undefined-footnote",`Footnote [^${node.label}] has no definition; it will read back as text.`);
      return `[^${node.label}]`;
    }
    if(node.type === "html") { if(node.id !== undefined || node.attributes) fail("Opaque HTML node attributes have no independent source mapping."); return sanitizeHtml(node.value ?? "",options); }
    if(node.type === "literal") return escapeText(node.value ?? "");
    fail(`Unsupported inline node: ${node.type}.`);
  }
  function depth(node: Node): number {
    return (["container","table"].includes(node.type) ? 1:0)+Math.max(0,...(node.body ?? node.children ?? []).map(depth));
  }
  function list(node: Node): string {
    if(typeof node.ordered !== "boolean" || !Array.isArray(node.children) || node.children.some(item=>item.type !== "listItem")) fail("Lists need ordered and listItem children.");
    if(node.id !== undefined || node.attributes) return safeNative(node);
    const start=node.start ?? 1;
    if(!Number.isInteger(start) || start<0) fail("List start must be a nonnegative integer.");
    return node.children.map((item,index)=> {
      if(item.id !== undefined || item.attributes) fail("List-item attributes need a native list wrapper.");
      const prefix=node.ordered ? `${start+index}. `:"- ";
      const task=item.checked === undefined ? "" : `[${item.checked ? "x":" "}] `;
      // Task markers are structural only at the start of a list item. A plain
      // paragraph or a heading can contain the same bracketed text unescaped.
      const text=blockArray(item.body ?? [],node.tight === true).replace(/^\[([ xX])\](?=[ \t])/u,"\\[$1]");
      return `${prefix}${task}${text.replace(/\n/g,`\n${" ".repeat(prefix.length)}`)}`;
    }).join(node.tight === true ? "\n":"\n\n");
  }
  function table(node: Node): string {
    const grid=tableGrid(node);
    const rows=node.children ?? [];
    const needsNative=rows.some(row=>row.id !== undefined || row.attributes || row.children?.some(cell=>cell.id !== undefined || cell.attributes || cell.header === false || cell.rowSpan === 1 || cell.colSpan === 1))
      || !grid.length && node.align !== undefined
      || ["header","transpose","align"].some(key=>Object.hasOwn(node.attributes ?? {},key));
    if(needsNative) return safeNative(node);
    const headerRow=(grid: Node[][])=>grid.length>0 && grid[0]!.every(cell=>cell.header === true) && grid.slice(1).every(row=>row.every(cell=>!cell.header));
    const hasHeaders=grid.some(row=>row.some(cell=>cell.header));
    let sourceGrid=grid;
    let transpose=false;
    if(hasHeaders && !headerRow(grid)) {
      const inverse=transposeTable(node);
      sourceGrid=tableGrid(inverse);
      if(!headerRow(sourceGrid)) return safeNative(node);
      transpose=true;
    }
    const header=headerRow(sourceGrid);
    const noMerges=sourceGrid.every(row=>row.every(cell=>!cell.rowSpan && !cell.colSpan));
    const labels=sourceGrid[0]?.map(cell=>cell.value) ?? [];
    const named=!transpose && header && sourceGrid.length>1 && noMerges
      && labels.every(value=>typeof value === "string" && Boolean(value.trim()) && !/[\r\n]/.test(value) && value.trim() === value)
      && new Set(labels).size === labels.length;
    const settings: Attributes={};
    if(header && !named) settings.header=true;
    if(transpose) settings.transpose=true;
    if(node.align) settings.align=node.align.map(value=>value ?? "-").join(",");
    const cellSource=(cell: Node)=> {
      const value=cell.body ? blockArray(cell.body):content(cell);
      return /^[>^]$/.test(value) ? `\\${value}`:value;
    };
    let body: string;
    if(named) {
      body=sourceGrid.slice(1).map(row=>row.map((cell,index)=> {
        const label=labels[index]!.replace(/[\\:]/g,"\\$&");
        const value=cellSource(cell);
        // Scalar fields stay on one readable line; block and multiline cells
        // retain indented continuation bodies, including code and lists.
        const scalar=!cell.body && value && !value.includes("\n");
        return `${index === 0 ? "- ":"  "}${label}:${scalar ? ` ${value}`:value ? `\n${value.split("\n").map(line=>`    ${line}`).join("\n")}`:""}`;
      }).join("\n")).join("\n\n");
    } else {
      const seen=new Set<Node>();
      body=sourceGrid.map((row,r)=>row.map((cell,c)=> {
        if(r>0 && sourceGrid[r-1]![c] === cell) return "^";
        if(c+1<row.length && row[c+1] === cell) return ">";
        if(seen.has(cell)) fail("Repeated table origin.");
        seen.add(cell);
        return cellSource(cell);
      }).map((value,index)=>`${index === 0 ? "- -":"  -"}${value ? ` ${value.replace(/\n/g,"\n    ")}`:""}`).join("\n")).join("\n\n");
    }
    const fence=":".repeat(2+depth(node));
    const attributes=writeAttributes(node,settings);
    const heading=["table",node.title !== undefined ? `[${caption(node)}]`:undefined,attributes].filter(Boolean).join(" ");
    return `${fence} ${heading}\n\n${body}${body ? "\n\n":""}${fence}`;
  }
  function block(node: Node, forceTabsWrapper = false): string {
    if(node.type === "paragraph") {
      const value=content(node);
      return node.id !== undefined || node.attributes || !value.trim() ? safeNative(node):value;
    }
    if(node.type === "heading") {
      if(!Number.isInteger(node.level)||node.level!<1||node.level!>6) fail("Heading level must be 1 through 6.");
      return `${"#".repeat(node.level!)} ${content(node)}${writeAttributes(node) ? ` ${writeAttributes(node)}`:""}`;
    }
    if(node.type === "code") {
      if(node.language && /[\s{}\n]/.test(node.language)) fail("Code language cannot contain whitespace or attribute delimiters.");
      if(typeof node.title === "object") fail("Code title must be literal text.");
      if(typeof node.title === "string" && /[\r\n]/.test(node.title) || node.meta && /[\r\n]/.test(node.meta)) fail("Code captions and metadata must fit on one source line.");
      const value=node.value ?? "";
      const marker=[node.language,node.meta].some(value=>value?.includes("`")) ? "~":"`";
      const fence=marker.repeat(Math.max(3,...Array.from(value.matchAll(new RegExp(`${marker}+`,"g")),m=>m[0].length+1)));
      const attrs=writeAttributes(node,typeof node.title === "string" ? {title:node.title}:{});
      const info=[node.language,attrs,node.meta].filter(Boolean).join(" ");
      return `${fence}${info}\n${value}\n${fence}`;
    }
    if(node.type === "horizontalRule") return node.id !== undefined || node.attributes ? safeNative(node):"---";
    if(node.type === "blockquote") return node.id !== undefined || node.attributes ? safeNative(node):blockArray(node.body ?? []).split("\n").map(value=>`> ${value}`).join("\n");
    if(node.type === "list") return list(node);
    if(node.type === "container" || node.type === "leaf") {
      if(!/^[a-z][a-z0-9_-]*$/.test(node.subType ?? "")) fail("Containers and leaf directives need a valid subtype.");
      if(!forceTabsWrapper && node.type === "container" && node.subType === "tabs" && !node.id && !node.title && !node.attributes && node.body?.every(child=>child.type === "container" && child.subType === "tab")) return blockArray(node.body);
      const fence=":".repeat(node.type === "leaf" ? 2:2+depth(node));
      const header=[node.subType,node.title !== undefined ? `[${caption(node)}]`:undefined,writeAttributes(node)].filter(Boolean).join(" ");
      return node.type === "leaf" ? `${fence}${header}` : `${fence} ${header}\n${blockArray(node.body ?? [])}\n${fence}`;
    }
    if(node.type === "lineBlock") {
      if(node.id !== undefined || node.attributes) fail("Line-block attributes have no lossless core source mapping.");
      const text=content(node).replace(/\\\n/g,"\n");
      return text.split("\n").map(line=>line ? `| ${line}`:"|").join("\n");
    }
    if(node.type === "table") return table(node);
    if(node.type === "definition") {
      let url=node.url ?? "";
      if(!safeUrl(url)) { warn(options,"unsafe-url","An unsafe reference definition URL was removed."); url=""; }
      return `[${node.label}]: ${destination(url)}${typeof node.title === "string" ? ` ${quoteAttribute(node.title)}`:""}`;
    }
    if(node.type === "footnoteDefinition") {
      // The first block shares the marker line; later lines indent four columns.
      const lines=blockArray(node.body ?? []).split("\n");
      return `[^${node.label}]:${lines.map((line,index)=>!line ? "" : index === 0 ? ` ${line}`:`    ${line}`).join("\n")}`;
    }
    if(node.type === "html") { if(node.id !== undefined || node.attributes) fail("Opaque HTML node attributes have no independent source mapping."); return sanitizeHtml(node.value ?? "",options); }
    if(node.type === "group") return safeNative(node);
    if(node.type === "literal") { if(node.id !== undefined || node.attributes) fail("Recovery literal attributes have no source mapping."); return sanitizeLiteral(node.value ?? "",options); }
    fail(`Unsupported block node: ${node.type}.`);
  }
  function blockArray(nodes: Node[], tightList = false): string {
    const blocks=nodes.map((node,index)=> {
      const neighboringTabs=node.type === "container" && node.subType === "tabs"
        && [nodes[index-1],nodes[index+1]].some(neighbor=>neighbor?.type === "container" && neighbor.subType === "tabs");
      return {node,value:block(node,neighboringTabs)};
    }).filter(({value})=>Boolean(value));
    // A blank line before an item's nested list would loosen the outer list.
    return blocks.map(({node,value},index)=> {
      const adjacent=tightList && node.type === "list" && blocks[index-1]?.node.type === "paragraph";
      return `${index === 0 ? "" : adjacent ? "\n":"\n\n"}${value}`;
    }).join("");
  }
  const metadata={...document.metadata};
  if(document.id !== undefined) {
    if(metadata.id !== undefined) warn(options,"metadata-conflict","The document ID takes precedence over metadata.id.");
    metadata.id=document.id;
  }
  if(document.title !== undefined) {
    if(metadata.title !== undefined) warn(options,"metadata-conflict","The document title takes precedence over metadata.title.");
    metadata.title=caption({type:"document",title:document.title});
  }
  if(document.attributes && Object.keys(document.attributes).length) fail("Root attributes have no core frontmatter mapping.");
  const head=Object.keys(metadata).length ? `---\n${yamlStringify(metadata,{schema:"core",lineWidth:0}).trimEnd()}\n---\n\n`:"";
  // Notes follow the body in list order. A note's first block shares the marker
  // line; every later line is indented four columns, as a list item's would be.
  const body=blockArray(document.body);
  return `${head}${body}${head || body ? "\n":""}`;
}
