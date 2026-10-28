// Evaluate the ESM parser before sanitize-html requires it on the Node 22 floor.
import { parseDocument } from "htmlparser2";
import sanitize from "sanitize-html";
import { attributeKey, compact } from "./grammar.js";
import { tableGrid } from "./tables.js";
import type { ConversionOptions, Node } from "./types.js";
import { warn } from "./types.js";

// Start with the maintained benign-tag profile; add documentation images/disclosures.
// CSS values are allowlisted per property: arbitrary URL-bearing CSS is never admitted.
const color = /^(?:#[\da-f]{3,8}|[a-z]+|rgba?\([\d.,% ]+\)|hsla?\([\d.,% ]+\))$/i;
const size = /^(?:auto|0|\d+(?:\.\d+)?(?:px|em|rem|%|ch|vh|vw))$/;
const policy: sanitize.IOptions = {
  // `picture` and `source` choose an image by color scheme or size, as READMEs use them.
  allowedTags: [...sanitize.defaults.allowedTags, "img", "details", "summary", "picture", "source"],
  allowedAttributes: {
    "*": ["id", "class", "style", "title", "lang", "dir", "data-*", "aria-*"],
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt", "width", "height", "loading"], source: ["srcset", "media", "type", "width", "height"],
    details: ["open"], ol: ["start"], li: ["value"],
    td: ["colspan", "rowspan", "headers"], th: ["colspan", "rowspan", "scope", "headers"],
  },
  allowedStyles: {"*": {color:[color], "background-color":[color], "text-align":[/^(?:left|right|center|justify|start|end)$/], "vertical-align":[/^(?:top|middle|bottom|baseline)$/], width:[size], height:[size], "max-width":[size], "font-weight":[/^(?:normal|bold|[1-9]00)$/], "font-style":[/^(?:normal|italic)$/], "text-decoration":[/^(?:none|underline|line-through)$/], "white-space":[/^(?:normal|pre|pre-wrap|pre-line|break-spaces)$/],
    // Layout uses native flow and logical axes, without positioning or arbitrary CSS.
    display:[/^flow-root$/], float:[/^inline-(?:start|end)$/],
    "inline-size":[size,/^fit-content$/], "max-inline-size":[size],
    "margin-inline-start":[/^(?:0|auto)$/], "margin-inline-end":[/^(?:0|auto)$/],
  }},
  transformTags: {
    "*": (tagName, original) => {
      const attribs={...original};
      const payload=attribs["data-attributes"];
      if(payload !== undefined) {
        delete attribs["data-attributes"];
        try {
          const value: unknown=JSON.parse(payload);
          if(value && typeof value === "object" && !Array.isArray(value)) {
            const safe=safeAuthoredAttributes(value as Record<string,unknown>,{});
            if(Object.keys(safe).length) attribs["data-attributes"]=JSON.stringify(safe);
          }
        } catch { /* Unsafe/invalid preservation payloads are not retained as source. */ }
      }
      return {tagName,attribs};
    },
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  // sanitize-html removes empty `hidden` as non-boolean, for `hidden="until-found"`;
  // HTML's `hidden` is boolean, so an allowed valueless one survives.
  nonBooleanAttributes: sanitize.defaults.nonBooleanAttributes.filter(name => name !== "hidden"),
  allowProtocolRelative: false,
  nonTextTags: ["script", "style", "textarea", "option", "iframe", "object", "embed", "svg", "math", "template"],
};
/**
 * Additions to the safe profile for content the site's own authors write.
 * Never use it for user-submitted, imported or third-party content.
 */
export interface HtmlAllowlist {
  /** Extra elements, such as custom elements, `button`, `input` or `template`. */
  tags?: readonly string[];
  /**
   * Extra attributes per element name, or `"*"` for every element. Names are
   * exact or end in `-*` for a prefix. An event-handler name such as `onclick`
   * must be listed exactly: it runs script, so it grants the content script access.
   */
  attributes?: Readonly<Record<string, readonly string[]>>;
  /** Extra style properties, exact names such as `--shiki-dark`, with allowed value patterns. */
  styles?: Readonly<Record<string, readonly RegExp[]>>;
  /** Extra URL schemes. `javascript` runs script from a link, so list it only for script-trusted content. */
  schemes?: readonly string[];
}
const allowlistPolicies = new WeakMap<HtmlAllowlist, sanitize.IOptions>();
function allowlistPolicy(allowlist: HtmlAllowlist): sanitize.IOptions {
  const cached = allowlistPolicies.get(allowlist);
  if (cached) return cached;
  const attributes: Record<string, string[]> = { ...(policy.allowedAttributes as Record<string, string[]>) };
  for (const [tag, names] of Object.entries(allowlist.attributes ?? {})) {
    for (const name of names) {
      // A wildcard could admit event handlers, so only a named prefix may end in *.
      if (!/^[a-zA-Z][\w:.-]*(?:-\*)?$/.test(name)) throw new TypeError(`Unsupported allowlisted attribute ${name}; use an exact name or a prefix ending in -*.`);
    }
    attributes[tag] = [...(attributes[tag] ?? []), ...names];
  }
  const styles = { ...(policy.allowedStyles!["*"] as Record<string, RegExp[]>) };
  for (const [name, patterns] of Object.entries(allowlist.styles ?? {})) styles[name] = [...(styles[name] ?? []), ...patterns];
  const tags = new Set(allowlist.tags ?? []);
  const result: sanitize.IOptions = {
    ...policy,
    allowedTags: [...(policy.allowedTags as string[]), ...tags],
    allowedAttributes: attributes,
    allowedStyles: { "*": styles },
    allowedSchemes: [...(policy.allowedSchemes as string[]), ...(allowlist.schemes ?? [])],
    // An allowlisted element keeps its content; the host chose it explicitly.
    nonTextTags: (policy.nonTextTags ?? []).filter(tag => !tags.has(tag)),
    allowVulnerableTags: tags.has("script") || tags.has("style"),
  };
  allowlistPolicies.set(allowlist, result);
  return result;
}
/**
 * Write rendered HTML's tags as Expressive Markdown reads them, for HTML
 * parsers that read them otherwise. A `/>` start tag of a non-void element is
 * the complete element, `<x></x>`; an unquoted value keeps a final `/`, so it
 * is quoted; `</br>` is `<br>`; a stray end tag, which closes no open
 * element, is left out; and an element `allowed` rejects is shown as text, as
 * GitHub's tag filter shows it. Returns the stray end tags and shown elements.
 */
export function normalizeTags(html: string, allowed: (name: string) => boolean = () => true, dropStrays = true): { html: string; strays: string[]; shown: string[] } {
  const parts: string[] = [], strays: string[] = [], shown: string[] = [];
  const show = (from: number, to: number, name: string) => { parts.push(html.slice(copied, from), escapeHtml(html.slice(from, to))); copied = to; if (!shown.includes(name)) shown.push(name); };
  const open = new TagStack("#document");
  let copied = 0, cursor = 0;
  for (let next = html.indexOf("<", cursor); next >= 0; next = html.indexOf("<", cursor)) {
    if (html.startsWith("<!--", next)) { const end = html.indexOf("-->", next + 4); cursor = end < 0 ? html.length : end + 3; continue; }
    const end = /^<\/([A-Za-z][A-Za-z0-9-]*)[^>]*>/.exec(html.slice(next, next + 256));
    if (end) {
      const name = end[1]!.toLowerCase();
      cursor = next + end[0].length;
      if (name === "br") { parts.push(html.slice(copied, next), "<br>"); copied = cursor; }
      else if (open.stack.lastIndexOf(name) > 0) { open.end(name); if (!allowed(name)) show(next, cursor, name); }
      else if (!allowed(name)) show(next, cursor, name);
      else if (dropStrays) { parts.push(html.slice(copied, next)); copied = cursor; strays.push(end[0]); }
      continue;
    }
    const tag = /^<[A-Za-z]/.test(html.slice(next, next + 2)) ? readStartTag(html, next) : undefined;
    if (!tag) { cursor = next + 1; continue; }
    if (!allowed(tag.name)) {
      // A raw-text element shows its content as text too.
      let to = tag.end;
      if (rawTextElements.has(tag.name) && !tag.selfClosing) { const close = new RegExp(`</${tag.name}[^>]*>`, "i").exec(html.slice(to)); to = close ? to + close.index + close[0].length : html.length; }
      else open.start(tag.name, tag.selfClosing);
      show(next, to, tag.name); cursor = to; continue;
    }
    for (const [from, to] of tag.unquoted) if (html[to - 1] === "/") { parts.push(html.slice(copied, from), `"${html.slice(from, to).replaceAll('"', "&quot;")}"`); copied = to; }
    const self = tag.selfClosing && !voidElements.has(tag.name);
    if (self) { parts.push(html.slice(copied, tag.end - 2).trimEnd(), `></${tag.name}>`); copied = tag.end; }
    open.start(tag.name, tag.selfClosing);
    cursor = tag.end;
    // Raw-text content holds no tags.
    if (rawTextElements.has(tag.name) && !tag.selfClosing && tag.name !== "pre") {
      const close = html.toLowerCase().indexOf(`</${tag.name}`, cursor);
      cursor = close < 0 ? html.length : close;
    }
  }
  parts.push(html.slice(copied));
  return { html: parts.join(""), strays, shown };
}
/** A start tag filtered by the safe profile: the sanitizer's own output may close it. */
export function sanitizeStartTag(open: string, options: ConversionOptions = {}): string {
  const clean = sanitizeFragment(open, options);
  const tag = /^<[A-Za-z]/.test(clean) ? readStartTag(clean, 0) : undefined;
  return tag ? clean.slice(0, tag.end) : clean;
}
/** Whether the safe profile, with a host's allowlist, keeps an element. */
export function allowedElement(name: string, allowlist?: HtmlAllowlist): boolean {
  return ((allowlist ? allowlistPolicy(allowlist) : policy).allowedTags as string[]).includes(name);
}
export function sanitizeHtml(value: string, options: ConversionOptions = {}, allowlist?: HtmlAllowlist): string {
  const output = sanitize(value, allowlist ? allowlistPolicy(allowlist) : policy);
  if (output !== value) warn(options, "html-filtered", "HTML was normalized or filtered by the safe documentation HTML profile.");
  return output;
}
const voidTags = new Set(["area","base","br","col","embed","hr","img","input","link","meta","source","track","wbr"]);
/** A fragment's unmatched tags: closings with no opening before them, and openings it leaves open. */
export function unmatchedTags(value: string): { closes: string[]; opens: string[] } {
  const stack: string[] = [], closes: string[] = [];
  for (const match of value.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<(\/?)([A-Za-z][A-Za-z0-9-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g)) {
    const name = match[2]!.toLowerCase();
    if (match[1]) { const at = stack.lastIndexOf(name); if (at < 0) closes.push(name); else stack.length = at; }
    else if (!match[3] && !voidTags.has(name)) stack.push(name);
  }
  return { closes, opens: stack };
}
/**
 * Filter an HTML fragment while keeping its unmatched tags as authored, such as
 * an HTML block holding only `<div class="entry">` or `</div>`, which CommonMark
 * ends at a blank line. The sanitizer would close or drop them; here the
 * fragment is filtered between markers, with an opening supplied before each
 * lone closing tag and the sanitizer's own closings cut away after it.
 */
export function sanitizeFragment(value: string, options: ConversionOptions = {}, allowlist?: HtmlAllowlist): string {
  const { closes, opens } = unmatchedTags(value);
  if (!closes.length && !opens.length) return sanitizeHtml(value, options, allowlist);
  const clean = sanitize(`${[...closes].reverse().map(name => `<${name}>`).join("")}\u0002${value}\u0003`, allowlist ? allowlistPolicy(allowlist) : policy);
  const start = clean.indexOf("\u0002"), end = clean.indexOf("\u0003");
  if (start < 0 || end < start) return sanitizeHtml(value, options, allowlist);
  const result = clean.slice(start + 1, end);
  if (result !== value) warn(options, "html-filtered", "HTML was normalized or filtered by the safe documentation HTML profile.");
  return result;
}
export function sanitizeLiteral(value: string, options: ConversionOptions = {}): string {
  // Plain recovery source cannot contain HTML; preserve its Markdown punctuation.
  return value.includes("<") ? sanitizeHtml(value,options):value;
}
export function safeUrl(url: string, image = false): boolean {
  const attribute = image ? "src" : "href";
  const tag = image ? "img" : "a";
  const output = sanitize(`<${tag} ${attribute}="${escapeHtml(url)}">${image ? "" : "link</a>"}`, policy);
  return output.includes(`${attribute}=`);
}
export function escapeHtml(value: string): string { return value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

const inlineNodes = new Set(["text","emphasis","strong","delete","underline","highlight","inlineCode","break","softBreak","link","image","inline"]);
const isInline = (node: Node) => inlineNodes.has(node.type) || ["group","html","literal"].includes(node.type) && node.display === "inline";
// Runs of inline nodes in block content become paragraphs; blank text separates nothing.
function wrapBlocks(items: Node[]): Node[] {
  const result: Node[] = [];
  let inline: Node[] = [];
  const flush = () => { if (inline.some(n=>n.type !== "text" || n.value?.trim())) result.push(compact({type:"paragraph"},inline)); inline=[]; };
  for (const child of items) { if (isInline(child)) inline.push(child); else { flush(); result.push(child); } }
  flush();
  return result;
}
// Elements whose children are inline content, and the structures whose children any context may hold.
// HTML title text collapses its whitespace, as a browser renders it.
function titled(items: Node[]): Node {
  const children = items.map(node => node.type === "text" ? {...node, value: node.value!.replace(/\s+/g, " ")} : node);
  const first = children[0], last = children.at(-1);
  if (first?.type === "text") children[0] = {...first, value: first.value!.trimStart()};
  if (last?.type === "text") children[children.length - 1] = {...children.at(-1)!, value: children.at(-1)!.value!.trimEnd()};
  return compact({type:"title"}, children);
}
const inlineContent = new Set(["span","a","b","strong","em","i","s","del","u","mark","code","p","h1","h2","h3","h4","h5","h6","summary","figcaption","caption","header"]);
const structures = new Set(["td","th","tr","thead","tbody","tfoot","table","ul","ol"]);
type Context = "block" | "inline" | "any";

export function htmlNodes(source: string, display: "inline" | "block", options: ConversionOptions): Node[] {
  const clean = sanitizeHtml(source, options);
  const document = parseDocument(clean);
  type HtmlNode = (typeof document.children)[number];
  // Each element maps within its context. One that cannot sit there, such as a
  // block inside inline content or a lone table row, keeps its filtered HTML.
  function convert(raw: HtmlNode, parent = "", context: Context = "block"): Node[] {
    const nodes = map(raw, parent, context);
    if (context === "any" || !("name" in raw)) return nodes;
    const fits = (node: Node) => context === "inline" ? isInline(node) : !["listItem","tableRow","tableCell"].includes(node.type);
    if (nodes.every(fits)) return nodes;
    return [{type:"html",display:context === "inline" ? "inline":"block",value:sanitize(clean.slice(raw.startIndex ?? 0,(raw.endIndex ?? clean.length - 1)+1),policy)}];
  }
  function map(raw: HtmlNode, parent: string, context: Context): Node[] {
    if (raw.type === "text") return raw.data ? [{type:"text",value:raw.data}] : [];
    if (!("name" in raw) || !("children" in raw)) return [];
    const tag = raw.name;
    const semanticContainer = tag === "section" && raw.attribs["data-type"] || tag === "div" && raw.attribs["data-type"] === "layout";
    const childContext: Context = inlineContent.has(tag) || context === "inline" && !structures.has(tag) ? "inline" : structures.has(tag) ? "any" : "block";
    const children = raw.children.flatMap(child=>convert(child,semanticContainer ? "semantic-section":tag,childContext));
    const attributes: Record<string,string|boolean> = {};
    let id: string | undefined;
    for (const [key,value] of Object.entries(raw.attribs)) {
      if (key === "id") id = value;
      else {
        const presentation = new Set(["data-column-widths","data-text-align","data-background-color","data-placement","data-responsive"]);
        const name=presentation.has(key) ? key.slice(5) : key;
        // A class list or style spanning lines collapses its line breaks, which carry no meaning there.
        attributes[attributeKey(name)] = key === "class" || key === "style" ? value.replace(/[ \t]*[\r\n]+[ \t]*/g, " ") : value;
      }
    }
    const finish = (node: Node): Node[] => {
      // Another attribute spanning lines has no Markdown attribute form, so the element stays HTML.
      if (Object.values(attributes).some(value => typeof value === "string" && /[\r\n]/.test(value))) return [{type:"html",display:context === "inline" ? "inline":"block",value:sanitize(clean.slice(raw.startIndex ?? 0,(raw.endIndex ?? clean.length - 1)+1),policy)}];
      if (id !== undefined) node.id = id;
      if(typeof attributes.dataAttributes === "string") {
        const payload=attributes.dataAttributes;
        delete attributes.dataAttributes;
        try {
          const authored: unknown=JSON.parse(payload);
          if(authored && typeof authored === "object" && !Array.isArray(authored)) {
            node.attributes=safeAuthoredAttributes(authored as Record<string,unknown>,options);
            if(!Object.keys(node.attributes).length) delete node.attributes;
            return [node];
          }
        } catch { /* Invalid profile payloads are discarded, never replayed as source. */ }
        warn(options,"invalid-html-attributes","Invalid native attribute preservation data was discarded.");
      }
      if (Object.keys(attributes).length) node.attributes = attributes;
      return [node];
    };
    const blocks = (items = children): Node[] => {
      const result: Node[] = [];
      let inline: Node[] = [];
      for (const child of items) {
        if (["paragraph","heading","blockquote","list","code","container","table","horizontalRule"].includes(child.type) || child.display === "block") {
          if (inline.some(n=>n.type !== "text" || n.value?.trim())) result.push(compact({type:"paragraph"},inline));
          inline=[]; result.push(child);
        } else inline.push(child);
      }
      if (inline.some(n=>n.type !== "text" || n.value?.trim())) result.push(compact({type:"paragraph"},inline));
      return result;
    };
    if(tag === "span" && typeof attributes.dataType === "string" && /^[a-z][a-z0-9_-]*$/.test(attributes.dataType)) {
      const node=compact({type:"inline",subType:attributes.dataType},children);
      delete attributes.dataType;
      if(node.subType === "mention" && typeof attributes.dataRef === "string") {node.ref=attributes.dataRef;delete attributes.dataRef;}
      return finish(node);
    }
    if(semanticContainer && typeof attributes.dataType === "string" && /^[a-z][a-z0-9_-]*$/.test(attributes.dataType)) {
      const node: Node={type:"container",subType:attributes.dataType,body:blocks(children.filter(child=>child.type !== "title"))};
      const title=children.find(child=>child.type === "title"); if(title) node.title=title;
      if(node.subType === "layout") for(const key of ["align","float"] as const) {
        const dataKey=key === "align" ? "dataAlign":"dataFloat";
        if(attributes[dataKey] !== undefined) {attributes[key]=attributes[dataKey];delete attributes[dataKey];}
      }
      delete attributes.dataType;return finish(node);
    }
    if(tag === "header" && parent === "semantic-section") return finish(titled(children));
    if (tag === "p" || /^h[1-6]$/.test(tag)) return finish(compact(tag === "p" ? {type:"paragraph"} : {type:"heading",level:Number(tag[1])},children));
    const wrapper: Record<string,string> = {b:"strong",strong:"strong",em:"emphasis",i:"emphasis",s:"delete",del:"delete",u:"underline",mark:"highlight"};
    if (wrapper[tag]) return finish(compact({type:wrapper[tag]},children));
    if (tag === "br" || tag === "hr") return finish({type:tag === "br" ? "break":"horizontalRule"});
    if (tag === "code") return finish({type:"inlineCode",value:children.map(n=>n.value ?? "").join("")});
    if (tag === "pre") {
      const code = children.length === 1 && children[0]?.type === "inlineCode" ? children[0] : undefined;
      const node: Node = {type:"code",value:code?.value ?? children.map(n=>n.value ?? "").join("")};
      const language = typeof code?.attributes?.class === "string" ? /(?:^|\s)language-([^\s]+)/.exec(code.attributes.class)?.[1] : undefined;
      if (language) node.language = language;
      if (code?.attributes) { const rest = {...code.attributes}; delete rest.class; Object.assign(attributes,rest); }
      return finish(node);
    }
    if (tag === "a") {
      const url = raw.attribs.href ?? ""; delete attributes.href;
      const node: Node = compact({type:"link",url},children);
      if (typeof attributes.title === "string") { node.title=attributes.title; delete attributes.title; }
      return finish(node);
    }
    if (tag === "img") {
      const node: Node = {type:"image",url:raw.attribs.src ?? "",alt:raw.attribs.alt ?? ""};
      delete attributes.src; delete attributes.alt;
      if (typeof attributes.title === "string") { node.title=attributes.title; delete attributes.title; }
      return finish(node);
    }
    if (tag === "blockquote") return finish({type:"blockquote",body:blocks()});
    if (tag === "ul" || tag === "ol") {
      const node: Node = {type:"list",ordered:tag === "ol",tight:false,children:children.filter(n=>n.type === "listItem")};
      if (tag === "ol" && attributes.start !== undefined) { node.start=Number(attributes.start); delete attributes.start; }
      return finish(node);
    }
    if (tag === "li") return finish({type:"listItem",body:blocks()});
    if (tag === "summary" && parent === "details" || tag === "figcaption" && parent === "figure" || tag === "caption" && parent === "table") return finish(titled(children));
    if (tag === "details" || tag === "figure") {
      const node: Node = {type:"container",subType:tag,body:blocks(children.filter(n=>n.type !== "title"))};
      const title = children.find(n=>n.type === "title");
      if (title) node.title=title;
      if (tag === "details" && raw.attribs.open !== undefined) attributes.open=true;
      return finish(node);
    }
    if (tag === "td" || tag === "th") {
      const node: Node = {type:"tableCell"};
      if (tag === "th") node.header=true;
      for (const [source,key] of [["colspan","colSpan"],["rowspan","rowSpan"]] as const) {
        if (raw.attribs[source] !== undefined) { node[key]=Number(raw.attribs[source]); delete attributes[source]; }
      }
      if (children.some(n=>!isInline(n))) node.body=blocks();
      else compact(node,children);
      return finish(node);
    }
    if (tag === "tr") return finish({type:"tableRow",children:children.filter(n=>n.type === "tableCell")});
    if (["thead","tbody","tfoot"].includes(tag)) return children;
    if (tag === "table") {
      const node: Node = {type:"table",children:children.filter(n=>n.type === "tableRow")};
      const caption=children.find(n=>n.type === "title"); if(caption) node.title=caption;
      // The table AST holds rectangular grids; an HTML table spanning otherwise stays opaque HTML.
      try { tableGrid(node); } catch { return [{type:"html",display:context === "inline" ? "inline":"block",value:sanitize(clean.slice(raw.startIndex ?? 0,(raw.endIndex ?? clean.length - 1)+1),policy)}]; }
      if(typeof attributes.dataAlign === "string") {
        try { const align: unknown=JSON.parse(attributes.dataAlign); if(Array.isArray(align) && align.every(value=>value === null || ["start","center","end"].includes(value))) {node.align=align;delete attributes.dataAlign;} } catch { /* Preserve invalid authored data as an ordinary attribute. */ }
      }
      return finish(node);
    }
    if (tag === "span" || tag === "div") return finish(tag === "span" ? {type:"group",display:"inline",tag:"span",children} : {type:"group",display:"block",tag:"div",children:blocks()});
    return [{type:"html",display,value:sanitize(raw.type === "tag" ? clean.slice(raw.startIndex ?? 0,(raw.endIndex ?? clean.length - 1)+1) : "",policy)}];
  }
  // Source indices are needed only for benign elements without a structured mapping.
  const indexed = parseDocument(clean,{withStartIndices:true,withEndIndices:true});
  const nodes = indexed.children.flatMap(child=>convert(child,"",display));
  return display === "block" ? wrapBlocks(nodes) : nodes;
}

/** Inert profile payloads preserve authored scalar types, never HTML execution fields. */
export function safeAuthoredAttributes(input: Record<string,unknown>, options: ConversionOptions): Record<string,string|boolean> {
  const result: Record<string,string|boolean>={};
  const reserved=new Set(["id","ref","source","data","type","subType","body","children","value","__proto__","prototype","constructor","dataAttributes"]);
  for(const [key,value] of Object.entries(input)) {
    if(!/^[A-Za-z][\w]*$/.test(key) || reserved.has(key) || /^on/i.test(key) || typeof value !== "string" && typeof value !== "boolean") { warn(options,"html-attribute-filtered",`Unsafe or reserved native attribute ${key} was discarded.`);continue; }
    if(["href","src","url"].includes(key) && typeof value === "string" && !safeUrl(value,key === "src")) {warn(options,"html-attribute-filtered",`Unsafe native URL attribute ${key} was discarded.`);continue;}
    if(key === "style" && typeof value === "string") {
      const clean=sanitize(`<span style="${escapeHtml(value)}"></span>`,policy);
      const element=parseDocument(clean).children.find(node=>"attribs" in node);
      const filtered=element && "attribs" in element ? element.attribs.style:undefined;
      if(filtered) result.style=filtered;
      if(filtered !== value) warn(options,"html-attribute-filtered","Unsafe or unsupported CSS was discarded from native attribute data.");
      continue;
    }
    result[key]=value;
  }
  return result;
}

// Standard-mode elements, matched as HTML matches tags. Void elements take no
// closing tag; the raw-text elements hold their content verbatim through their
// end; and HTML's optional end tags close an element where HTML closes it.
export const voidElements = new Set(["area","base","br","col","embed","hr","img","input","link","meta","source","track","wbr"]);
// Code and pre keep authored HTML, including entities and highlighting spans,
// opaque to Markdown; the HTML sanitizer still filters their rendered content.
export const rawTextElements = new Set(["script","style","textarea","title","pre","code"]);
const paragraphClosers = ["address","article","aside","blockquote","details","dialog","div","dl","fieldset","figcaption","figure","footer","form","h1","h2","h3","h4","h5","h6","header","hgroup","hr","main","menu","nav","ol","p","pre","search","section","table","ul"];
// HTML's optional tags: each element's end tag may be left out before these
// start tags, or at the end of its parent's content. A heading start tag also
// closes an open heading, as HTML's parser closes it.
const headings = ["h1","h2","h3","h4","h5","h6"];
const closedBy: Record<string, string[]> = {
  ...Object.fromEntries(headings.map(heading => [heading, headings])),
  li:["li"], dt:["dt","dd"], dd:["dt","dd"], p:paragraphClosers, rt:["rt","rp"], rp:["rt","rp"],
  optgroup:["optgroup","hr"], option:["option","optgroup","hr"], thead:["tbody","tfoot"], tbody:["tbody","tfoot"],
  tfoot:[], tr:["tr"], td:["td","th"], th:["td","th"],
};
/** Elements whose end tag HTML lets the end of their parent's content imply. */
export const parentEndCloses = new Set(["li","dd","p","rt","rp","optgroup","option","tbody","tfoot","tr","td","th"]);
/**
 * The open elements while tags are read, starting from one root element.
 * Each method reports whether the root has closed.
 */
export class TagStack {
  readonly stack: string[];
  constructor(root: string) { this.stack = [root]; }
  /** A start tag closes the open elements HTML's optional end tags let it close. */
  start(name: string, selfClosing = false): boolean {
    for (let index = this.stack.length - 1; index >= 0; index--) {
      const open = this.stack[index]!;
      if (closedBy[open]?.includes(name)) { this.stack.length = index; break; }
      if (!parentEndCloses.has(open)) break;
    }
    if (!this.stack.length) return true;
    if (!voidElements.has(name) && !selfClosing) this.stack.push(name);
    return false;
  }
  /** An end tag closes its open element and those inside it; a stray one changes nothing. */
  end(name: string): boolean {
    const index = this.stack.lastIndexOf(name);
    if (index >= 0) this.stack.length = index;
    return !this.stack.length;
  }
}
/** `unquoted` holds the ranges of unquoted attribute values. */
export interface StartTag { name: string; end: number; selfClosing: boolean; unquoted: [number, number][] }
/**
 * Read a start tag at `start`, which holds `<`, ending no later than `limit`.
 * It follows HTML's tokenizer: `/` makes the tag self-closing only right
 * before `>` outside an attribute value, so `href=/a/>` is not self-closing.
 */
export function readStartTag(source: string, start: number, limit = source.length): StartTag | undefined {
  const name = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(source.slice(start, start + 64))?.[1];
  if (!name) return;
  let cursor = start + name.length + 1;
  if (cursor < limit && !/[\s/>]/.test(source[cursor]!)) return;
  const space = (char: string | undefined) => char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
  const unquoted: [number, number][] = [];
  while (cursor < limit) {
    const char = source[cursor]!;
    if (space(char)) { cursor++; continue; }
    if (char === ">") return { name: name.toLowerCase(), end: cursor + 1, selfClosing: false, unquoted };
    if (char === "/") {
      if (source[cursor + 1] === ">") return { name: name.toLowerCase(), end: cursor + 2, selfClosing: true, unquoted };
      cursor++; continue;
    }
    if (char === "<") return;
    // An attribute name, whose first character may be `=`, then an optional value.
    cursor++;
    while (cursor < limit && !space(source[cursor]) && !"/>=".includes(source[cursor]!)) cursor++;
    let after = cursor;
    while (after < limit && space(source[after])) after++;
    if (source[after] !== "=") continue;
    cursor = after + 1;
    while (cursor < limit && space(source[cursor])) cursor++;
    const quote = source[cursor];
    if (quote === '"' || quote === "'") {
      const close = source.indexOf(quote, cursor + 1);
      if (close < 0 || close >= limit) return;
      cursor = close + 1;
    } else {
      const from = cursor;
      while (cursor < limit && !space(source[cursor]) && source[cursor] !== ">") cursor++;
      unquoted.push([from, cursor]);
    }
  }
  return;
}
/**
 * The element starting at `start`: its start tag's end, and where it closes.
 * `closed` is "tag" for a closing tag, "implied" where HTML's optional end
 * tags close it, "void" for a void element, "self" for a start tag ending in
 * `/>`, and false when `limit` comes first.
 */
export interface ElementExtent { name: string; tagEnd: number; closeStart: number; end: number; closed: "tag" | "implied" | "void" | "self" | false }
/**
 * The end of the first code span or fence between `from` and `before`, when
 * one starts there: a fence at a line start runs to its closing fence, and a
 * backtick run to the next run of the same length before a blank line.
 */
export function skipCode(source: string, from: number, before: number, limit: number): number | undefined {
  const tick = /`+|(?:^|\n)[ \t]*~{3,}/g;
  tick.lastIndex = from;
  // A run that starts before `before` ends there, at its `<`: searching only the
  // text before it keeps an element's scan linear in its length.
  const head = source.slice(0, before);
  for (let match = tick.exec(head); match; match = tick.exec(head)) {
    const run = match[0].replace(/^\n?[ \t]*/, "");
    const lineStart = source.lastIndexOf("\n", match.index + match[0].length - run.length - 1) + 1;
    const fence = run.length >= 3 && !source.slice(lineStart, match.index + match[0].length - run.length).trim();
    if (fence) {
      const close = new RegExp(`\\n[ \\t]*${run[0] === "`" ? "`" : "~"}{${run.length},}[ \\t]*(?=\\n|$)`, "g");
      close.lastIndex = match.index + match[0].length;
      const found = close.exec(source);
      return found && found.index < limit ? found.index + found[0].length : limit;
    }
    if (run[0] !== "`") continue;
    const end = new RegExp(`(?<!\`)\`{${run.length}}(?!\`)`, "g");
    end.lastIndex = match.index + run.length;
    const found = end.exec(source);
    const blank = /\n[ \t]*\n/.exec(source.slice(match.index, found ? found.index : limit));
    if (found && found.index < limit && !blank) return found.index + run.length;
  }
  return;
}
export function readElement(source: string, start: number, limit = source.length): ElementExtent | undefined {
  const tag = readStartTag(source, start, limit);
  if (!tag) return;
  const extent = (closeStart: number, end: number, closed: ElementExtent["closed"]): ElementExtent => ({ name: tag.name, tagEnd: tag.end, closeStart, end, closed });
  if (voidElements.has(tag.name)) return extent(tag.end, tag.end, "void");
  // `/>` closes any element: this is a Markdown parser, not a browser.
  if (tag.selfClosing) return extent(tag.end, tag.end, "self");
  const closing = (name: string, from: number) => {
    const match = new RegExp(`</${name}(?=[\\s/>])[^>]*>`, "ig");
    match.lastIndex = from;
    const found = match.exec(source);
    return found && found.index + found[0].length <= limit ? found : undefined;
  };
  if (rawTextElements.has(tag.name)) {
    const match = closing(tag.name, tag.end);
    return match ? extent(match.index, match.index + match[0].length, "tag") : extent(limit, limit, false);
  }
  const open = new TagStack(tag.name);
  let cursor = tag.end;
  while (cursor < limit) {
    const next = source.indexOf("<", cursor);
    if (next < 0 || next >= limit) break;
    // Code is opaque: tags inside a code span or fence never count.
    const code = skipCode(source, cursor, next, limit);
    if (code !== undefined) { cursor = code; continue; }
    const skip = (terminator: string) => { const close = source.indexOf(terminator, next + 2); return close < 0 ? limit : close + terminator.length; };
    if (source.startsWith("<!--", next)) { cursor = skip("-->"); continue; }
    if (source.startsWith("<![CDATA[", next)) { cursor = skip("]]>"); continue; }
    if (source.startsWith("<!", next) || source.startsWith("<?", next)) { cursor = skip(">"); continue; }
    const end = /^<\/([A-Za-z][A-Za-z0-9-]*)[^>]*>/.exec(source.slice(next, Math.min(limit, next + 256)));
    if (end) {
      if (open.end(end[1]!.toLowerCase())) return extent(next, next + end[0].length, "tag");
      cursor = next + end[0].length; continue;
    }
    const inner = readStartTag(source, next, limit);
    if (!inner) { cursor = next + 1; continue; }
    if (open.start(inner.name, inner.selfClosing)) return extent(next, next, "implied");
    if (rawTextElements.has(inner.name) && !inner.selfClosing) {
      const match = closing(inner.name, inner.end);
      cursor = match ? match.index + match[0].length : limit;
      open.end(inner.name);
    } else cursor = inner.end;
  }
  return extent(limit, limit, parentEndCloses.has(tag.name) ? "implied" : false);
}
