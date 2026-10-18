import { escapeHtml, sanitizeHtml } from "./html.js";
import { sourceKey } from "./grammar.js";
import { ConversionError, warn, type ConversionOptions, type Document, type Node } from "./types.js";

type LayoutAlignment = "start" | "center" | "end";
function isAlignment(value: unknown): value is LayoutAlignment { return value === "start" || value === "center" || value === "end"; }

const nativeAttributes = new Set([
  "id", "class", "style", "title", "lang", "dir", "href", "name", "target", "rel",
  "src", "alt", "width", "height", "loading", "open", "start", "value",
  "colspan", "rowspan", "scope", "headers",
]);

export interface HtmlRenderContext {
  /** Escape authored text for HTML text or quoted attribute values. */
  escape(value: string): string;
  /** Render value/body/children through child overrides; excludes the title slot. */
  renderChildren(): string;
  /** Use this node's default mapping while keeping overrides on its descendants. */
  renderDefault(): string;
  render(node: Node): string;
}
export type HtmlTransformer = (node: Readonly<Node>, context: HtmlRenderContext) => string | undefined;
export interface HtmlRenderOptions extends Pick<ConversionOptions, "onDiagnostic"> {
  /** Lookup order: "type:subType", "type", "*", then the built-in mapping. */
  transformers?: Readonly<Record<string, HtmlTransformer>>;
}

/** Render with node overrides, then apply the shared safe HTML profile once. */
export function renderHtml(document: Document, options: HtmlRenderOptions = {}): string {
  if (document?.type !== "document" || document.version !== 1 || !Array.isArray(document.body)) {
    throw new ConversionError("unsupported-version", "Expected a document with version 1 and a body array.");
  }
  const active = new Set<Node>();
  const transformers = options.transformers ?? {};
  let inheritedAlignment: LayoutAlignment | undefined;
  function content(node: Node): string {
    return node.value != null ? escapeHtml(node.value) : (node.body ?? node.children ?? []).map(render).join("");
  }
  function title(node: Node): string {
    return typeof node.title === "string" ? escapeHtml(node.title) : node.title ? render(node.title) : "";
  }
  function attributes(node: Node, extra: Record<string, string | boolean | number> = {}): string {
    const values: Record<string, string | boolean | number> = { ...node.attributes, ...extra };
    if (inheritedAlignment !== undefined && node.type === "image") {
      values.style = `max-inline-size:100%${typeof values.style === "string" ? `;${values.style}` : ""}`;
    }
    if (typeof extra.style === "string" && typeof node.attributes?.style === "string") values.style = `${extra.style};${node.attributes.style}`;
    if (node.id !== undefined) values.id = node.id;
    return Object.entries(values).map(([key, value]) => {
      let name = sourceKey(key);
      // Names cannot be escaped. The shared sanitizer owns value and URL policy.
      if (!/^[a-zA-Z][\w:-]*$/.test(name) || value === false) return "";
      if (!nativeAttributes.has(name) && !name.startsWith("data-") && !name.startsWith("aria-")) name = `data-${name}`;
      return value === true ? ` ${name}` : ` ${name}="${escapeHtml(String(value))}"`;
    }).join("");
  }
  function element(node: Node, tag: string, value: string, extra: Record<string, string | boolean | number> = {}): string {
    return `<${tag}${attributes(node, extra)}>${value}</${tag}>`;
  }
  function layout(node: Node): string {
    const requested = node.attributes?.align;
    const alignment = isAlignment(requested) ? requested : inheritedAlignment ?? "start";
    const float = node.attributes?.float;
    if (requested !== undefined && !isAlignment(requested)) warn(options, "unsupported-layout-attribute", "Layout align needs start, center or end; using inherited alignment or start.");
    if (float !== undefined && float !== "start" && float !== "end") warn(options, "unsupported-layout-attribute", "Layout float needs start or end; using ordinary flow.");
    function item(value: string, align: LayoutAlignment, inlineSize: "fit-content" | "auto" = "fit-content"): string {
      const start = align === "start" ? "0" : "auto";
      const end = align === "end" ? "0" : "auto";
      // This wrapper uses the parent's direction even when its child has dir=ltr
      // inside RTL content. Native logical margins handle placement; the child's
      // own direction and explicit text styles still control its text.
      return `<div style="inline-size:${inlineSize};max-inline-size:100%;margin-inline-start:${start};margin-inline-end:${end}">${value}</div>`;
    }
    const previous = inheritedAlignment;
    let value: string;
    inheritedAlignment = alignment;
    try {
      value = `${node.title ? item(`<header>${title(node)}</header>`, alignment) : ""}${(node.body ?? []).map(child => {
        const isLayout = child.type === "container" && child.subType === "layout";
        const output = render(child);
        // A floated layout must share its siblings' normal-flow context so their
        // text can flow around it. An item wrapper would isolate that float.
        if (isLayout && (child.attributes?.float === "start" || child.attributes?.float === "end")) return output;
        return item(output, isLayout && isAlignment(child.attributes?.align) ? child.attributes.align : alignment, child.type === "horizontalRule" ? "auto" : "fit-content");
      }).join("")}`;
    } finally { inheritedAlignment = previous; }
    return element(node, "div", value, {
      "data-type": "layout",
      style: `display:flow-root;max-inline-size:100%;text-align:${alignment}${float === "start" || float === "end" ? `;float:inline-${float}` : ""}`,
    });
  }
  function defaultRender(node: Node): string {
    switch (node.type) {
      case "document": return `${node.title ? `<h1>${title(node)}</h1>` : ""}${content(node)}`;
      case "title": case "literal": return content(node);
      case "text": return node.id !== undefined || Object.keys(node.attributes ?? {}).length ? element(node, "span", content(node)) : content(node);
      case "html": return node.value ?? "";
      case "paragraph": return element(node, "p", content(node));
      case "heading":
        if (!Number.isInteger(node.level) || node.level! < 1 || node.level! > 6) throw new ConversionError("unsupported-html-node", "HTML headings need a level from 1 to 6.");
        return element(node, `h${node.level}`, content(node));
      case "strong": return element(node, "strong", content(node));
      case "emphasis": return element(node, "em", content(node));
      case "delete": return element(node, "s", content(node));
      case "underline": return element(node, "u", content(node));
      case "highlight": return element(node, "mark", content(node));
      case "inlineCode": return element(node, "code", escapeHtml(node.value ?? ""));
      case "softBreak": return "\n";
      case "break": return `<br${attributes(node)}>`;
      case "horizontalRule": return `<hr${attributes(node)}>`;
      case "link": return element(node, "a", content(node), { href: node.url ?? "", ...(typeof node.title === "string" ? { title: node.title } : {}) });
      case "image": return `<img${attributes(node, { src: node.url ?? "", alt: node.alt ?? "", ...(typeof node.title === "string" ? { title: node.title } : {}) })}>`;
      case "blockquote": return element(node, "blockquote", content(node));
      case "list": return element(node, node.ordered ? "ol" : "ul", content(node), node.ordered && node.start !== undefined ? { start: node.start } : {});
      // Form controls are outside the safe profile, so task status stays inert.
      case "listItem": return element(node, "li", `${node.checked === undefined ? "" : node.checked ? "☑ " : "☐ "}${content(node)}`);
      case "code": {
        const code = element(node, "pre", `<code${node.language ? ` class="language-${escapeHtml(node.language)}"` : ""}>${escapeHtml(node.value ?? "")}</code>`);
        return node.title ? `<figure>${code}<figcaption>${title(node)}</figcaption></figure>` : code;
      }
      case "group": return element(node, node.display === "inline" ? "span" : "div", content(node));
      case "lineBlock": return element(node, "div", content(node), { "data-type": "line-block", style: "white-space:pre-line" });
      case "inline": case "leaf": return element(node, node.type === "leaf" && node.subType === "toc" ? "nav" : "span", `${title(node)}${content(node)}`, { "data-type": node.subType ?? "", ...(node.ref !== undefined ? { "data-ref": node.ref } : {}) });
      case "container": {
        if (node.subType === "layout") return layout(node);
        const heading = title(node);
        if (node.subType === "details") return element(node, "details", `${node.title ? `<summary>${heading}</summary>` : ""}${content(node)}`);
        if (node.subType === "figure") return element(node, "figure", `${content(node)}${node.title ? `<figcaption>${heading}</figcaption>` : ""}`);
        return element(node, "section", `${node.title ? `<header>${heading}</header>` : ""}${content(node)}`, { "data-type": node.subType ?? "" });
      }
      case "table": return element(node, "table", `${node.title ? `<caption>${title(node)}</caption>` : ""}${content(node)}`);
      case "tableRow": return element(node, "tr", content(node));
      case "tableCell": return element(node, node.header ? "th" : "td", content(node), { ...(node.colSpan !== undefined ? { colspan: node.colSpan } : {}), ...(node.rowSpan !== undefined ? { rowspan: node.rowSpan } : {}) });
      default: throw new ConversionError("unsupported-html-node", `No HTML transformer for node ${node.type}.`);
    }
  }
  function render(node: Node): string {
    if (!node || typeof node !== "object" || typeof node.type !== "string") throw new ConversionError("unsupported-html-node", "Expected an HTML-renderable node.");
    if (active.has(node)) throw new ConversionError("cyclic-html-node", "Cannot render a cyclic node reference.");
    active.add(node);
    try {
      const keys = [...(node.subType === undefined ? [] : [`${node.type}:${node.subType}`]), node.type, "*"];
      const key = keys.find(candidate => Object.hasOwn(transformers, candidate));
      const result = (key === undefined ? undefined : transformers[key])?.(node, {
        escape: escapeHtml, renderChildren: () => content(node), renderDefault: () => defaultRender(node), render,
      });
      if (result !== undefined && typeof result !== "string") throw new TypeError("HTML transformers must return a string or undefined.");
      return result ?? defaultRender(node);
    } finally { active.delete(node); }
  }
  // Include custom output in the same sanitization pass as the built-in output.
  return sanitizeHtml(render(document), options);
}
