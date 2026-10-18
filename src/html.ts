// Evaluate the ESM parser before sanitize-html requires it on the Node 22 floor.
import { parseDocument } from "htmlparser2";
import sanitize from "sanitize-html";
import { attributeKey, compact } from "./grammar.js";
import type { ConversionOptions, Node } from "./types.js";
import { warn } from "./types.js";

// Start with the maintained benign-tag profile; add documentation images/disclosures.
// CSS values are allowlisted per property: arbitrary URL-bearing CSS is never admitted.
const color = /^(?:#[\da-f]{3,8}|[a-z]+|rgba?\([\d.,% ]+\)|hsla?\([\d.,% ]+\))$/i;
const size = /^(?:auto|0|\d+(?:\.\d+)?(?:px|em|rem|%|ch|vh|vw))$/;
const policy: sanitize.IOptions = {
  allowedTags: [...sanitize.defaults.allowedTags, "img", "details", "summary"],
  allowedAttributes: {
    "*": ["id", "class", "style", "title", "lang", "dir", "data-*", "aria-*"],
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt", "width", "height", "loading"],
    details: ["open"], ol: ["start"], li: ["value"],
    td: ["colspan", "rowspan", "headers"], th: ["colspan", "rowspan", "scope", "headers"],
  },
  allowedStyles: {"*": {color:[color], "background-color":[color], "text-align":[/^(?:left|right|center|justify|start|end)$/], "vertical-align":[/^(?:top|middle|bottom|baseline)$/], width:[size], height:[size], "max-width":[size], "font-weight":[/^(?:normal|bold|[1-9]00)$/], "font-style":[/^(?:normal|italic)$/], "text-decoration":[/^(?:none|underline|line-through)$/], "white-space":[/^(?:normal|pre|pre-wrap|pre-line|break-spaces)$/]}},
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
  allowProtocolRelative: false,
  nonTextTags: ["script", "style", "textarea", "option", "iframe", "object", "embed", "svg", "math", "template"],
};
export function sanitizeHtml(value: string, options: ConversionOptions = {}): string {
  const output = sanitize(value, policy);
  if (output !== value) warn(options, "html-filtered", "HTML was normalized or filtered by the safe documentation HTML profile.");
  return output;
}
export function safeUrl(url: string, image = false): boolean {
  const attribute = image ? "src" : "href";
  const tag = image ? "img" : "a";
  const output = sanitize(`<${tag} ${attribute}="${escapeHtml(url)}">${image ? "" : "link</a>"}`, policy);
  return output.includes(`${attribute}=`);
}
export function escapeHtml(value: string): string { return value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

export function htmlNodes(source: string, display: "inline" | "block", options: ConversionOptions): Node[] {
  const clean = sanitizeHtml(source, options);
  const document = parseDocument(clean);
  type HtmlNode = (typeof document.children)[number];
  function convert(raw: HtmlNode, parent = ""): Node[] {
    if (raw.type === "text") return raw.data ? [{type:"text",value:raw.data}] : [];
    if (!("name" in raw) || !("children" in raw)) return [];
    const tag = raw.name;
    const children = raw.children.flatMap(child=>convert(child,tag === "section" && raw.attribs["data-type"] ? "semantic-section":tag));
    const attributes: Record<string,string|boolean> = {};
    let id: string | undefined;
    for (const [key,value] of Object.entries(raw.attribs)) {
      if (key === "id") id = value;
      else {
        const presentation = new Set(["data-column-widths","data-text-align","data-background-color","data-placement","data-responsive"]);
        const name=presentation.has(key) ? key.slice(5) : key;
        attributes[attributeKey(name)] = value;
      }
    }
    const finish = (node: Node): Node[] => {
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
    if(tag === "section" && typeof attributes.dataType === "string" && /^[a-z][a-z0-9_-]*$/.test(attributes.dataType)) {
      const node: Node={type:"container",subType:attributes.dataType,body:blocks(children.filter(child=>child.type !== "title"))};
      const title=children.find(child=>child.type === "title"); if(title) node.title=title;
      delete attributes.dataType;return finish(node);
    }
    if(tag === "header" && parent === "semantic-section") return finish(compact({type:"title"},children));
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
    if (tag === "summary" && parent === "details" || tag === "figcaption" && parent === "figure" || tag === "caption" && parent === "table") return finish(compact({type:"title"},children));
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
      if (children.some(n=>["paragraph","heading","list","code","container","table","blockquote"].includes(n.type))) node.body=blocks();
      else compact(node,children);
      return finish(node);
    }
    if (tag === "tr") return finish({type:"tableRow",children:children.filter(n=>n.type === "tableCell")});
    if (["thead","tbody","tfoot"].includes(tag)) return children;
    if (tag === "table") {
      const node: Node = {type:"table",children:children.filter(n=>n.type === "tableRow")};
      const caption=children.find(n=>n.type === "title"); if(caption) node.title=caption;
      if(typeof attributes.dataAlign === "string") {
        try { const align: unknown=JSON.parse(attributes.dataAlign); if(Array.isArray(align) && align.every(value=>value === null || ["left","center","right"].includes(value))) {node.align=align;delete attributes.dataAlign;} } catch { /* Preserve invalid authored data as an ordinary attribute. */ }
      }
      return finish(node);
    }
    if (tag === "span" || tag === "div") return finish(tag === "span" ? {type:"group",display:"inline",tag:"span",children} : {type:"group",display:"block",tag:"div",children:blocks()});
    return [{type:"html",display,value:sanitize(raw.type === "tag" ? clean.slice(raw.startIndex ?? 0,(raw.endIndex ?? clean.length - 1)+1) : "",policy)}];
  }
  // Source indices are needed only for benign elements without a structured mapping.
  const indexed = parseDocument(clean,{withStartIndices:true,withEndIndices:true});
  return indexed.children.flatMap(child=>convert(child));
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
