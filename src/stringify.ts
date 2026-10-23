import { stringify as yamlStringify } from "yaml";
import { escapeText, startsMention, type TextContext } from "./escape.js";
import { alertMarker, destination, diagnoseIds, normalizeLabel, readAttributes, readInfo, sameData, spellingHolds, structuralTypes, trailingAttributeLists, quoteAttribute, sourceKey, tokenHandle, writeAttributes } from "./grammar.js";
import { escapeHtml, rawTextElements, safeAuthoredAttributes, safeUrl, sanitizeFragment, sanitizeHtml, sanitizeLiteral, voidElements } from "./html.js";
import { syntax } from "./escape.js";
import { parse } from "./parse.js";
import { preferForms } from "./lint.js";
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
// Node field contracts, shared by every validation call.
const known=new Set(["type","subType","id","title","body","children","value","attributes","position","source","data","level","ordered","start","tight","checked","url","alt","language","meta","ref","label","referenceType","spelling","titleSpelling","align","header","colSpan","rowSpan","display","tag","open","close","syntax","version","metadata"]);
const special=["level","ordered","start","tight","checked","url","alt","language","meta","ref","label","referenceType","spelling","titleSpelling","align","header","colSpan","rowSpan","display","tag","open","close","syntax","version","metadata"];
const inlineTypes=new Set(["text","emphasis","strong","delete","underline","highlight","inlineCode","break","softBreak","link","image","inline","footnoteReference","linkReference","imageReference"]);
const blockTypes=new Set(["paragraph","heading","blockquote","list","code","lineBlock","table","container","leaf","horizontalRule","footnoteDefinition","definition","strayFence"]);
const structural: Record<string,string[]> = {
    document:["version","metadata","syntax"], htmlElement:["tag","open","close","tight","display"], footnoteReference:["label"], footnoteDefinition:["label"],
    container:["spelling","titleSpelling"], definition:["label","url"], linkReference:["label","referenceType"], imageReference:["label","referenceType","alt"], heading:["level"], list:["ordered","start","tight"], listItem:["checked","tight"],
    link:["url"],image:["url","alt"],code:["language","meta"], inline:["ref"],table:["align"],tableCell:["header","colSpan","rowSpan"],group:["display","tag"],html:["display"],literal:["display"],
};
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
  for(const key of Object.keys(node)) if(!known.has(key)) fail(`${path}.${key} has no Markdown mapping.`);
  for(const key of ["ordered","tight","checked","header"] as const) if(node[key] !== undefined && typeof node[key] !== "boolean") fail(`${path}.${key} must be a boolean.`);
  for(const key of ["url","alt","language","meta","ref","subType"] as const) if(node[key] !== undefined && typeof node[key] !== "string") fail(`${path}.${key} must be a string.`);
  for(const key of ["level","start","colSpan","rowSpan"] as const) if(node[key] !== undefined && (!Number.isInteger(node[key]) || node[key]! < (key === "start" ? 0:1))) fail(`${path}.${key} has an invalid integer value.`);
  if(node.align !== undefined && (!Array.isArray(node.align) || node.align.some(value=>value !== null && !["start","center","end"].includes(value)))) fail(`${path}.align needs column alignment values.`);
  if(node.type === "group" && !Array.isArray(node.children)) fail(`${path} needs structural children.`);
  for(const key of special) if(key in node && !structural[node.type]?.includes(key)) fail(`${path}.${key} is not defined for ${node.type}.`);
  if(node.subType !== undefined && !["container","inline","leaf"].includes(node.type)) fail(`${path}.subType is not defined for ${node.type}.`);
  if(node.titleSpelling !== undefined && !["bracketed","unbracketed"].includes(node.titleSpelling)) fail(`${path}.titleSpelling needs bracketed or unbracketed.`);
  if(node.spelling !== undefined && !["container","alert"].includes(node.spelling)) fail(`${path}.spelling needs container or alert.`);
  if(node.ref !== undefined && node.subType !== "mention") fail(`${path}.ref is only defined for mentions.`);
  if(["document","container","blockquote","listItem","footnoteDefinition"].includes(node.type) && !Array.isArray(node.body)) fail(`${path} needs a block body.`);
  if(["footnoteReference","footnoteDefinition"].includes(node.type)) {
    if(typeof node.label !== "string" || tokenHandle(node.label) !== node.label) fail(`${path}.label needs a footnote label.`);
    if(node.id !== undefined || node.attributes) fail(`${path} has no footnote attribute source mapping.`);
  }
  if(["list","table","tableRow"].includes(node.type) && !Array.isArray(node.children)) fail(`${path} needs structural children.`);
  if(["paragraph","heading","title","emphasis","strong","delete","underline","highlight","lineBlock","link","linkReference","tableCell"].includes(node.type) && node.value == null && node.children == null && !(node.type === "tableCell" && node.body)) fail(`${path} needs content.`);
  if(node.type === "strayFence" && !/^:{3,}$/.test(node.value ?? "")) fail(`${path} needs a bare colon fence value.`);
  if(["text","inlineCode","code","html","literal","strayFence"].includes(node.type) && typeof node.value !== "string") fail(`${path} needs literal value content.`);
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
  const isInline=(child:Node)=>inlineTypes.has(child.type) || ["group","html","literal","htmlElement"].includes(child.type) && child.display === "inline";
  const isBlock=(child:Node)=>blockTypes.has(child.type) || ["group","html","literal","htmlElement"].includes(child.type) && child.display === "block";
  if(node.body?.some(child=>!isBlock(child))) fail(`${path}.body needs block nodes.`);
  if(node.children && !["list","table","tableRow","group"].includes(node.type) && node.children.some(child=>!isInline(child))) fail(`${path}.children needs inline nodes.`);
  if(["link","image","definition"].includes(node.type) && typeof node.url !== "string") fail(`${path} needs a string URL.`);
  if(["image","imageReference"].includes(node.type) && typeof node.alt !== "string") fail(`${path} needs string alternative text.`);
  if(node.type === "lineBlock" && node.value?.includes("\n")) fail(`${path} cannot store represented line boundaries in a literal value.`);
  if(node.type === "group" && !["inline","block"].includes(node.display ?? "")) fail(`${path} needs inline or block display.`);
  if(node.type === "group" && node.tag !== undefined && node.tag !== (node.display === "inline" ? "span":"div")) fail(`${path} native tag conflicts with its display.`);
  if(["link","linkReference"].includes(node.type) && node.children?.some(child=>["link","linkReference"].includes(child.type))) fail(`${path} cannot contain nested links.`);
  if(node.type === "tableRow" && node.children?.some(child=>child.type !== "tableCell")) fail(`${path} needs tableCell children.`);
  if(node.type === "document" && (node as Document).syntax !== undefined && !["compatible","modern"].includes((node as Document).syntax!)) fail(`${path}.syntax needs compatible or modern.`);
  if(node.type === "htmlElement") {
    const tag=typeof node.tag === "string" && /^[A-Za-z][A-Za-z0-9-]*$/.test(node.tag) ? node.tag : fail(`${path} needs an element tag name.`);
    // `</br>` is read as a `<br>` element.
    if(typeof node.open !== "string" || !new RegExp(`^<${tag}(?=[\\s/>])[^<]*>$`,"i").test(node.open) && !(tag.toLowerCase() === "br" && /^<\/br[^<]*>$/i.test(node.open))) fail(`${path}.open needs the element's start tag.`);
    if(node.close !== undefined && (typeof node.close !== "string" || !new RegExp(`^</${tag}[ \\t]*>$`,"i").test(node.close))) fail(`${path}.close needs the element's closing tag.`);
    if(!["inline","block"].includes(node.display ?? "")) fail(`${path} needs inline or block display.`);
    if(node.body && node.display !== "block") fail(`${path} holds blocks only with block display.`);
  }
  seen.delete(node);
}

// Writing works on normalized copies; spellings are fingerprinted on the parsed originals.
const originals=new WeakMap<Node,Node>();
function normalizeAbsence(node: Node, seen=new Set<Node>()): Node {
  if(!node || typeof node !== "object") fail("Expected a document node.");
  if(seen.has(node)) fail("A document cannot contain cyclic content.");
  seen.add(node);
  const copy={...node};
  for(const key of Object.keys(copy) as (keyof Node)[]) if(copy[key] === null) delete copy[key];
  for(const key of ["body","children"] as const) if(Array.isArray(copy[key])) copy[key]=copy[key].map(child=>normalizeAbsence(child,seen));
  if(typeof copy.title === "object" && copy.title !== null) copy.title=normalizeAbsence(copy.title,seen);
  seen.delete(node); originals.set(copy,node); return copy;
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
  // The copies drop each spelling the lint rules flag, so the preferred form is written.
  if(options.preferredForms) preferForms(document);
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
  // Authored spellings recorded in `source`. Each is written back only while
  // it still reads as the node; otherwise the preferred spelling is written.
  // Probes read source with the document's own syntax and profile.
  const probeOptions: ConversionOptions={...(options.trustedHtml ? {trustedHtml:true}:{}),...(document.syntax === "modern" ? {syntax:"modern" as const}:{})};
  const spelling=(node: Node, key: string): string | undefined => typeof node.source?.[key] === "string" ? node.source[key] as string : undefined;
  const reads=(markdown: string, node: Node, pick: (document: Document)=>Node | undefined = document=>document.body[0], key?: string, holder: Node = node): boolean => {
    if(key && spellingHolds(originals.get(holder) ?? holder,holder,key)) return true;
    try { const found=pick(parse(markdown,probeOptions)); return found !== undefined && sameData(found,node); } catch { return false; }
  };
  function attributes(node: Node, extra: Attributes = {}): string {
    const authored=spelling(node,"attributes");
    if(authored) {
      const probe: Node={type:node.type};
      let rest=authored;
      while(rest) { const attrs=readAttributes(rest); if(!attrs) break; if(attrs.id !== undefined) probe.id=attrs.id; if(Object.keys(attrs.attributes).length) probe.attributes={...probe.attributes,...attrs.attributes}; rest=rest.slice(attrs.length); }
      if(!rest && probe.id === node.id && sameData(probe.attributes ?? {},{...node.attributes,...extra})) return authored;
    }
    return writeAttributes(node,extra);
  }
  function fence(node: Node): number {
    let nested=0;
    const visit=(child: Node)=>{ if(["container","table"].includes(child.type)) nested=Math.max(nested,fence(child)); else (child.body ?? child.children ?? []).forEach(visit); };
    (node.body ?? node.children ?? []).forEach(visit);
    return Math.max(typeof node.source?.fence === "number" ? node.source.fence:0,3,nested+1);
  }
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
    if(node.type === "inline") return wrapper("span",kids(),{...(node.subType !== undefined ? {"data-type":node.subType}:{}),...(node.ref !== undefined ? {"data-ref":node.ref}:{})});
    if(node.type === "container" && !["details","figure"].includes(node.subType ?? "")) {
      const heading=node.title ? `<header>${typeof node.title === "object" ? native(node.title):escapeHtml(node.title)}</header>`:"";
      return node.subType === undefined ? wrapper("div",`${heading}${(node.body ?? []).map(native).join("")}`) : wrapper("section",`${heading}${(node.body ?? []).map(native).join("")}`,{"data-type":node.subType});
    }
    if(node.type === "group") return wrapper(node.tag ?? (node.display === "inline" ? "span":"div"),(node.children ?? []).map(native).join(""));
    if(node.type === "blockquote") return wrapper("blockquote",(node.body ?? []).map(native).join(""));
    if(node.type === "list") return wrapper(node.ordered ? "ol":"ul",(node.children ?? []).map(native).join(""),node.start !== undefined ? {start:node.start}:{});
    if(node.type === "htmlElement") return `${elementTag(node.open!)}${node.value !== undefined ? rawTextElements.has(node.tag!) ? node.value : escapeHtml(node.value) : [...(node.body ?? []),...(node.children ?? [])].map(native).join("")}${voidElements.has(node.tag!) ? "" : node.close ?? `</${node.tag}>`}`;
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
    if(node.type === "html") { if(node.id !== undefined || node.attributes) fail("Opaque HTML node attributes have no independent source mapping."); return options.trustedHtml ? node.value ?? "" : sanitizeFragment(node.value ?? "",options); }
    fail(`Node ${node.type} cannot be represented in a native HTML wrapper.`);
  }
  function safeNative(node: Node): string {
    const raw=native(node);
    const clean=sanitizeHtml(raw,options);
    if(clean !== raw) warn(options,"presentation-filtered","Native presentation was normalized or filtered by the safe HTML profile.");
    return clean;
  }
  function inline(node: Node, previous?: Node, next?: Node, context: TextContext = {}): string {
    const attrs=attributes(node);
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
      // Underscores do not delimit inside a word, so they need word boundaries.
      const underscore=node.type !== "delete" && spelling(node,"marker") === "_"
        && !(previous?.type === "text" && /[\p{L}\p{N}_]$/u.test(previous.value ?? "")) && !(next?.type === "text" && /^[\p{L}\p{N}_]/u.test(next.value ?? ""));
      const value=content(node,{...context,mentionStart:false,marks:`${context.marks ?? ""}${node.type === "delete" ? "~":underscore ? "_":"*"}`});
      if(!value || /^\s|\s$/u.test(value)
        || /^[\p{P}\p{S}]/u.test(value) && previous?.type === "text" && /[^\s\p{P}\p{S}]$/u.test(previous.value ?? "")
        || /[\p{P}\p{S}]$/u.test(value) && next?.type === "text" && /^[^\s\p{P}\p{S}]/u.test(next.value ?? "")) return safeNative(node);
      const mark=node.type === "strong" ? underscore ? "__":"**" : node.type === "emphasis" ? underscore ? "_":"*":"~~";
      return `${mark}${value}${mark}`;
    }
    if(["underline","highlight","group"].includes(node.type)) return safeNative(node);
    if(node.type === "inlineCode") {
      if(attrs) return safeNative(node);
      const ticks=spelling(node,"fence");
      const value=node.value ?? "";
      // A recorded run works while the code holds no run of the same length.
      if(ticks && /^`+$/.test(ticks) && !Array.from(value.matchAll(/`+/g)).some(m=>m[0].length === ticks.length)) {
        const padding=/^`|`$/.test(value) || (/^ | $/.test(value) && /[^ ]/.test(value)) ? " ":"";
        return `${ticks}${padding}${value}${padding}${ticks}`;
      }
      return inlineCode(value);
    }
    if(node.type === "break") {
      if(attrs) return safeNative(node);
      const spaces=node.source?.spaces;
      return typeof spaces === "number" && spaces >= 2 && next ? `${" ".repeat(spaces)}\n` : "\\\n";
    }
    if(node.type === "softBreak") { if(attrs) fail("A soft break cannot carry authored attributes in Markdown."); return "\n"; }
    // A multiline tooltip, as HTML allows, has no Markdown title spelling.
    if((node.type === "link" || node.type === "image") && typeof node.title === "string" && /[\r\n]/.test(node.title)) return safeNative(node);
    if(node.type === "link" || node.type === "image") {
      const form=spelling(node,"form");
      if(node.type === "link" && form && !attrs && node.title === undefined && node.value !== undefined) {
        const text=node.value, url=node.url ?? "";
        if(form === "angle" && (url === text || url === `mailto:${text}`) && !/[\s<>]/.test(text) && reads(`<${text}>`,{type:"paragraph",children:[node]},undefined,"form",node)) return `<${text}>`;
        // A bare URL is written as text the reader links again by itself.
        if(form === "bare" && syntax.linkify.match(text)?.[0]?.raw === text && reads(text,{type:"paragraph",children:[node]},undefined,"form",node)) return text;
      }
      const tooltip=typeof node.title === "string" ? ` ${quoteAttribute(node.title)}` : "";
      const label=node.type === "image" ? escapeText(node.alt ?? "",{block:false,label:true}) : content(node,{label:true,protectAutolinks:false,mentionStart:false});
      const authored=spelling(node,"target");
      const target=authored && reads(`[x]${authored}`,{type:node.type,url:node.url ?? "",...(node.title !== undefined ? {title:node.title}:{})},document=>{
        const found=document.body[0]?.children?.[0]; return found ? {type:node.type,url:found.url,...(found.title !== undefined ? {title:found.title}:{})} as Node : undefined;
      },"target",node) ? authored : `(${destination(node.url ?? "")}${tooltip})`;
      return `${node.type === "image" ? "!":""}[${label}]${target}${attrs}`;
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
      // A typeless inline is a bracketed span: its attribute list is its only marker.
      if(node.subType === undefined) return `[${content(node,{label:true})}]${attrs || "{}"}`;
      if(!/^[a-z][a-z0-9_-]*$/.test(node.subType ?? "")) fail("Inline directives need a valid subtype.");
      if(node.subType === "mention") {
        // Markdown cannot spell a mention at a non-whitespace source boundary.
        // Native semantic markup preserves an authored occurrence there without
        // inserting spaces into the document or broadening mention recognition.
        if(!startsMention({...context,...(previous ? {previous}:{})})) return safeNative(node);
        const ref=node.ref;
        const suffix=ref !== undefined && tokenHandle(ref) === ref ? `#${ref}`:"";
        const following=next?.type === "text" ? next.value ?? "" : "";
        if(spelling(node,"form") === "bare" && node.value !== undefined && tokenHandle(node.value) === node.value && !writeAttributes(node,ref !== undefined && !suffix ? {ref}:{})
          && !(suffix ? /^[{]/ : /^[\p{L}\p{M}\p{N}_#{-]/u).test(following)) return `@${node.value}${suffix}`;
        const extra: Attributes=ref !== undefined && !suffix ? {ref}:{};
        return `@[${content(node,{label:true})}]${suffix}${attributes(node,extra)}`;
      }
      return `:${node.subType}${node.value !== undefined || node.children ? `[${content(node,{label:true})}]`:""}${attrs}`;
    }
    if(node.type === "footnoteReference") {
      if(!footnotes.has(node.label!)) warn(options,"undefined-footnote",`Footnote [^${node.label}] has no definition; it will read back as text.`);
      return `[^${node.label}]`;
    }
    if(node.type === "html") { if(node.id !== undefined || node.attributes) fail("Opaque HTML node attributes have no independent source mapping."); return options.trustedHtml ? node.value ?? "" : sanitizeFragment(node.value ?? "",options); }
    if(node.type === "htmlElement") return `${elementTag(node.open!)}${node.value !== undefined && rawTextElements.has(node.tag!) ? node.value : content(node)}${node.close ?? ""}`;
    if(node.type === "literal") return escapeText(node.value ?? "");
    fail(`Unsupported inline node: ${node.type}.`);
  }
  // A container title in its authored spelling. Unbracketed text protects an
  // opening bracket or brace, and a final list that would read as attributes.
  function title(node: Node): string {
    if(node.type !== "container" || node.titleSpelling !== "unbracketed") return `[${caption(node)}]`;
    caption(node);
    const text=content(node.title as Node,{block:false});
    const opened=/^[[{]/.test(text) ? `\\${text}`:text;
    const { text: kept, lists }=trailingAttributeLists(opened);
    return lists.length ? `${kept}${opened.slice(kept.length).replace(/([ \t])\{/g,"$1\\{")}` : opened;
  }
  // GFM pipe form: one header row, inline cells and no merges, captions or attributes.
  function pipeTable(node: Node, grid: Node[][]): string | undefined {
    if(!grid.length || node.title !== undefined || node.attributes || node.id !== undefined) return;
    if(!grid[0]!.every(cell=>cell.header) || grid.slice(1).some(row=>row.some(cell=>cell.header))) return;
    const cells=new Set<Node>();
    for(const row of grid) for(const cell of row) { if(cells.has(cell) || cell.body || cell.colSpan || cell.rowSpan) return; cells.add(cell); }
    const write=(cell: Node)=> {
      if(JSON.stringify(cell).includes("inlineCode") && JSON.stringify(cell).includes("|")) return;
      const value=content(cell).replace(/\|/g,"\\|");
      return value.includes("\n") ? undefined : /^[>^]$/.test(value) ? `\\${value}`:value;
    };
    const rows=grid.map(row=>row.map(write));
    if(rows.some(row=>row.some(value=>value === undefined))) return;
    const align=grid[0]!.map((_cell,index)=>({start:":---",center:":---:",end:"---:"} as Record<string,string>)[node.align?.[index] ?? ""] ?? "---");
    return [rows[0]!,align,...rows.slice(1)].map(row=>`| ${row.join(" | ")} |`).join("\n");
  }
  function list(node: Node): string {
    if(typeof node.ordered !== "boolean" || !Array.isArray(node.children) || node.children.some(item=>item.type !== "listItem")) fail("Lists need ordered and listItem children.");
    if(node.id !== undefined || node.attributes) return safeNative(node);
    const start=node.start ?? 1;
    if(!Number.isInteger(start) || start<0) fail("List start must be a nonnegative integer.");
    const marker=spelling(node,"marker");
    const bullet=!node.ordered && (marker === "*" || marker === "+") ? marker:"-";
    const delimiter=node.ordered && marker === ")" ? ")":".";
    const same=node.ordered && spelling(node,"numbering") === "same";
    return node.children.map((item,index)=> {
      if(item.id !== undefined || item.attributes) fail("List-item attributes need a native list wrapper.");
      // An item's own bullet or delimiter, which `modern` syntax keeps in the list.
      const own=document.syntax === "modern" ? spelling(item,"bullet"):undefined;
      const prefix=node.ordered ? `${same ? start:start+index}${own === ")" || own === "." ? own:delimiter} `:`${own && "-*+".includes(own) ? own:bullet} `;
      const task=item.checked === undefined ? "" : `[${item.checked ? spelling(item,"marker") === "X" ? "X":"x":" "}] `;
      // Task markers are structural only at the start of a list item. A plain
      // paragraph or a heading can contain the same bracketed text unescaped.
      const text=blockArray(item.body ?? [],node.tight === true && item.tight !== false).replace(/^\[([ xX])\](?=[ \t])/u,"\\[$1]");
      return `${prefix}${task}${text.replace(/\n(?=[^\n])/g,`\n${" ".repeat(prefix.length)}`)}`;
    }).join(node.tight === true ? "\n":"\n\n");
  }
  function table(node: Node): string {
    const grid=tableGrid(node);
    const rows=node.children ?? [];
    const needsNative=rows.some(row=>row.id !== undefined || row.attributes || row.children?.some(cell=>cell.id !== undefined || cell.attributes || cell.header === false || cell.rowSpan === 1 || cell.colSpan === 1))
      || !grid.length && node.align !== undefined
      || ["header","transpose","align"].some(key=>Object.hasOwn(node.attributes ?? {},key));
    if(needsNative) return safeNative(node);
    if(spelling(node,"form") === "pipe") {
      const authored=spelling(node,"markdown");
      if(authored && reads(authored,node,undefined,"markdown")) return authored;
      const pipe=pipeTable(node,grid);
      if(pipe) return pipe;
    }
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
    const named=!transpose && header && sourceGrid.length>1 && noMerges && spelling(node,"form") !== "positional"
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
    const colons=":".repeat(fence(node));
    const heading=["table",node.title !== undefined ? `[${caption(node)}]`:undefined,writeAttributes(node,settings)].filter(Boolean).join(" ");
    return `${colons} ${heading}\n\n${body}${body ? "\n\n":""}${colons}`;
  }
  const elementTag=(open: string) => options.trustedHtml || open.startsWith("</") ? open : sanitizeFragment(open,options);
  function block(node: Node, forceTabsWrapper = false): string {
    if(node.type === "paragraph") {
      const value=content(node);
      return node.id !== undefined || node.attributes || !value.trim() ? safeNative(node):value;
    }
    if(node.type === "heading") {
      if(!Number.isInteger(node.level)||node.level!<1||node.level!>6) fail("Heading level must be 1 through 6.");
      const text=`${content(node)}${attributes(node) ? ` ${attributes(node)}`:""}`;
      const underline=spelling(node,"underline");
      if(spelling(node,"form") === "setext" && node.level! <= 2 && text.trim() && !text.includes("\n")) {
        const char=node.level === 1 ? "=":"-";
        return `${text}\n${underline && new RegExp(`^\\${char}+$`).test(underline) ? underline:char.repeat(3)}`;
      }
      const closing=spelling(node,"closing");
      return `${"#".repeat(node.level!)} ${text}${closing && /^#+$/.test(closing) ? ` ${closing}`:""}`;
    }
    if(node.type === "code") {
      if(node.language && /[\s{}\n]/.test(node.language)) fail("Code language cannot contain whitespace or attribute delimiters.");
      if(typeof node.title === "object") fail("Code title must be literal text.");
      if(typeof node.title === "string" && /[\r\n]/.test(node.title) || node.meta && /[\r\n]/.test(node.meta)) fail("Code captions and metadata must fit on one source line.");
      const value=node.value ?? "";
      // Indented code holds no info and no surrounding blank lines.
      if(spelling(node,"form") === "indented" && !node.language && !node.meta && node.title === undefined && node.id === undefined && !node.attributes
        && value.trim() && !/^[ \t]*\n|\n[ \t]*$/.test(value) && !/^[ \t]*$/.test(value.split("\n")[0]!)) return value.split("\n").map(line=>line ? `    ${line}`:"").join("\n");
      const recorded=spelling(node,"fence");
      const marker=recorded?.[0] === "~" || [node.language,node.meta].some(value=>value?.includes("`")) ? "~":"`";
      const needed=Math.max(3,...Array.from(value.matchAll(new RegExp(`${marker}+`,"g")),m=>m[0].length+1));
      const fence=marker.repeat(recorded && /^(`+|~+)$/.test(recorded) && recorded[0] === marker ? Math.max(recorded.length,needed):needed);
      const attrs=writeAttributes(node,typeof node.title === "string" ? {title:node.title}:{});
      const authored=spelling(node,"info");
      const probe=authored && !authored.includes("\n") && !(marker === "`" && authored.includes("`")) ? {...readInfo(authored),value:node.value} as Node : undefined;
      const info=probe && sameData(probe,node) ? authored! : [node.language,attrs,node.meta].filter(Boolean).join(" ");
      return `${fence}${info}\n${value}\n${fence}`;
    }
    if(node.type === "horizontalRule") {
      if(node.id !== undefined || node.attributes) return safeNative(node);
      const marker=spelling(node,"marker");
      return marker && /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(marker) && marker.trimEnd() === marker ? marker:"---";
    }
    if(node.type === "blockquote") {
      if(node.id !== undefined || node.attributes) return safeNative(node);
      // Literal text that would open an alert stays a quotation.
      const text=blockArray(node.body ?? []).replace(alertMarker,marker=>structuralTypes.has(alertMarker.exec(marker)![1]!.toLowerCase()) ? marker:`\\${marker}`);
      return text.split("\n").map(value=>`> ${value}`).join("\n");
    }
    if(node.type === "list") return list(node);
    if(node.type === "htmlElement") {
      const authored=spelling(node,"markdown");
      if(authored && reads(authored,node,undefined,"markdown")) return authored;
      if(!node.body) return `${elementTag(node.open!)}${node.value ?? ""}${node.close ?? ""}`;
      // Blank lines inside the element give its paragraphs `<p>`. A tight
      // element's blocks are written line by line while that reads back.
      const wrap=(gap: string, body: string) => `${elementTag(node.open!)}${body ? `${gap}${body}`:""}${node.close === undefined ? "" : `${body ? gap:""}${node.close}`}`;
      if(node.tight !== false) {
        const body=node.body ?? [];
        const lines=wrap("\n",body.map(child=>block(child)).filter(Boolean).join("\n"));
        // Only text after a paragraph can join it; other lines keep their blocks.
        const joins=body.some((child,index)=>index>0 && body[index-1]!.type === "paragraph" && ["paragraph","htmlElement"].includes(child.type));
        if(!joins || reads(lines,node)) return lines;
      }
      return wrap("\n\n",blockArray(node.body ?? []));
    }
    if(node.type === "container" || node.type === "leaf") {
      // Only a container may omit its type; a leaf directive names one.
      if(!(node.type === "container" && node.subType === undefined) && !/^[a-z][a-z0-9_-]*$/.test(node.subType ?? "")) fail("Containers and leaf directives need a valid subtype.");
      if(!forceTabsWrapper && spelling(node,"form") !== "explicit" && node.type === "container" && node.subType === "tabs" && !node.id && !node.title && !node.attributes && node.body?.every(child=>child.type === "container" && child.subType === "tab")) return blockArray(node.body);
      if(node.type === "container" && node.spelling === "alert") {
        if(node.id !== undefined || node.attributes || structuralTypes.has(node.subType!)) warn(options,"unsupported-alert","An alert has no attribute or structural-type spelling; it is written as a colon container.");
        else {
          const body=blockArray(node.body ?? []);
          // A body that could continue the marker line as something other than
          // a paragraph, such as a setext underline, starts after a blank line.
          const joined=node.body?.[0]?.type === "paragraph" && !/^[ \t]*(?:=+|-+)[ \t]*(?:\n|$)/.test(body);
          const authoredType=spelling(node,"type");
          const lines=[`[!${authoredType?.toLowerCase() === node.subType ? authoredType : node.subType}]${node.title !== undefined ? ` ${caption(node)}`:""}`,...(body ? [...(joined ? []:[""]),...body.split("\n")]:[])];
          return lines.map(line=>line ? `> ${line}`:">").join("\n");
        }
      }
      const colons=":".repeat(node.type === "leaf" ? 2:fence(node));
      // A recorded header is kept while it still names the same type, title and attributes.
      const authored=spelling(node,"header");
      const keep=authored !== undefined && !authored.includes("\n") && reads(node.type === "leaf" ? `::${authored}` : `:::${authored}\n:::`,node.type === "leaf" ? node:{...node,body:[]},parsed=>{
        // A lone tab reads back inside its implicit group.
        const first=parsed.body[0];
        const found=node.subType === "tab" && first?.subType === "tabs" ? first.body?.[0] : first;
        return found ? {...found,...(node.type === "leaf" ? {}:{body:[]})} : undefined;
      },"header",node);
      // An unreadable header writes its type and its kept remainder.
      const rest=spelling(node,"rest");
      if(rest !== undefined && node.type === "container" && node.title === undefined && !node.attributes && node.id === undefined) return `${colons}${node.subType ? ` ${node.subType}`:""}${rest}\n${blockArray(node.body ?? [])}\n${colons}`;
      const header=keep ? authored! : [node.subType,node.title !== undefined ? title(node):undefined,writeAttributes(node)].filter(Boolean).join(" ");
      return node.type === "leaf" ? `${colons}${header}` : `${colons}${keep || !header ? "":" "}${header}\n${blockArray(node.body ?? [])}\n${colons}`;
    }
    if(node.type === "lineBlock") {
      if(node.id !== undefined || node.attributes) fail("Line-block attributes have no lossless core source mapping.");
      const authored=spelling(node,"markdown");
      if(authored && reads(authored,node,undefined,"markdown")) return authored;
      const text=content(node).replace(/\\\n/g,"\n");
      return text.split("\n").map(line=>line ? `| ${line}`:"|").join("\n");
    }
    if(node.type === "table") return table(node);
    if(node.type === "definition") {
      let url=node.url ?? "";
      if(!safeUrl(url)) { warn(options,"unsafe-url","An unsafe reference definition URL was removed."); url=""; }
      const authored=spelling(node,"markdown");
      if(authored && url === node.url && reads(authored,node,undefined,"markdown")) return authored;
      return `[${node.label}]: ${destination(url)}${typeof node.title === "string" ? ` ${quoteAttribute(node.title)}`:""}`;
    }
    if(node.type === "footnoteDefinition") {
      // The first block shares the marker line; later lines indent four columns.
      const lines=blockArray(node.body ?? []).split("\n");
      return `[^${node.label}]:${lines.map((line,index)=>!line ? "" : index === 0 ? ` ${line}`:`    ${line}`).join("\n")}`;
    }
    if(node.type === "html") { if(node.id !== undefined || node.attributes) fail("Opaque HTML node attributes have no independent source mapping."); return options.trustedHtml ? node.value ?? "" : sanitizeFragment(node.value ?? "",options); }
    if(node.type === "strayFence") return node.value!;
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
    // A blank line between an item's blocks would loosen its list.
    return blocks.map(({node,value},index)=> {
      // A tight item's blocks touch: a block that interrupts a paragraph follows it directly.
      const interrupts=["list","blockquote","container","table"].includes(node.type) || node.type === "code" && node.source?.form !== "indented" || node.type === "heading" && node.source?.form !== "setext";
      const adjacent=tightList && interrupts && blocks[index-1]?.node.type === "paragraph";
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
  // A syntax other than the host's default is written as the `markdownSyntax` key.
  if(document.syntax !== undefined && document.syntax !== (options.syntax ?? "compatible")) metadata.markdownSyntax=document.syntax;
  const authoredYaml=spelling(document,"frontmatter");
  const keepYaml=authoredYaml !== undefined && reads(`---\n${authoredYaml}\n---\n`,{type:"document",body:[],...(document.id !== undefined ? {id:document.id}:{}),...(document.title !== undefined ? {title:document.title}:{}),...(document.metadata ? {metadata:document.metadata}:{}),...(document.syntax ? {syntax:document.syntax}:{})} as Node,parsed=>({...parsed,version:undefined,body:[]} as unknown as Node),"frontmatter",document);
  const head=keepYaml ? `---\n${authoredYaml}\n---\n\n` : Object.keys(metadata).length ? `---\n${yamlStringify(metadata,{schema:"core",lineWidth:0}).trimEnd()}\n---\n\n`:"";
  const body=blockArray(document.body);
  return `${head}${body}${head || body ? "\n":""}`;
}
