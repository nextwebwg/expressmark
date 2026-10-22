import { headingAnchors } from "./anchors.js";
import { escapeHtml, sanitizeHtml, type HtmlAllowlist } from "./html.js";
import { footnoteDefinitions, linkDefinitions, references, referenceOrder } from "./references.js";
import { normalizeLabel } from "./grammar.js";
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
  /**
   * Add the host's elements, attributes, styles and URL schemes to the safe
   * profile, for raw HTML and transformer output alike. Only for content the
   * site's own authors write; never for user-submitted or third-party content.
   */
  trustedHtml?: HtmlAllowlist;
  /** Give headings without an authored ID their recommended anchor ID. */
  headingIds?: boolean;
  /**
   * Transform every rendered text run and code value after the safe profile,
   * such as escaping `{` for a template host. It receives HTML-escaped text and
   * returns HTML; raw HTML and attribute values never pass through it.
   */
  escapeText?: (html: string) => string;
  /** Render the designated document title as a leading `<h1>`. Default `true`. */
  title?: boolean;
}

// Text runs are bracketed with control characters, which HTML text never
// carries, so the hook can find them after the profile has run.
const TEXT_START = "\u0002", TEXT_END = "\u0003";

/** Render with node overrides, then apply the shared safe HTML profile once. */
export function renderHtml(document: Document, options: HtmlRenderOptions = {}): string {
  if (document?.type !== "document" || document.version !== 1 || !Array.isArray(document.body)) {
    throw new ConversionError("unsupported-version", "Expected a document with version 1 and a body array.");
  }
  const active = new Set<Node>();
  const diagnostics: ConversionOptions = options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {};
  const anchors = options.headingIds ? headingAnchors(document) : undefined;
  const hook = options.escapeText;
  function text(value: string): string {
    const escaped = escapeHtml(value);
    // oxlint-disable-next-line no-control-regex -- authored text cannot forge a marker.
    return hook ? `${TEXT_START}${escaped.replace(/[\u0002\u0003]/g, "")}${TEXT_END}` : escaped;
  }
  const transformers = options.transformers ?? {};
  let inheritedAlignment: LayoutAlignment | undefined;
  // Definitions render once, collected at the end and numbered by first
  // reference; each note counts its references for back-links.
  const notes = footnoteDefinitions(document);
  const rendered = referenceOrder(document, notes);
  const numbers = new Map(rendered.map((label, index) => [label, index + 1]));
  const counts = new Map<string, number>();
  const count = (label: string) => { if (notes.has(label)) counts.set(label, (counts.get(label) ?? 0) + 1); };
  references(document, count);
  for (const label of rendered) for (const child of notes.get(label)!.body ?? []) references(child, count);
  const occurrences = new Map<string, number>();
  // Reference links resolve here, against the first definition of each label.
  const definitions = linkDefinitions(document);
  function content(node: Node): string {
    return node.value != null ? text(node.value) : (node.body ?? node.children ?? []).filter(child => child?.type !== "footnoteDefinition").map(render).join("");
  }
  function title(node: Node): string {
    return typeof node.title === "string" ? text(node.title) : node.title ? render(node.title) : "";
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
    if (requested !== undefined && !isAlignment(requested)) warn(diagnostics, "unsupported-layout-attribute", "Layout align needs start, center or end; using inherited alignment or start.");
    if (float !== undefined && float !== "start" && float !== "end") warn(diagnostics, "unsupported-layout-attribute", "Layout float needs start or end; using ordinary flow.");
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
      case "document": {
        const value = `${node.title && options.title !== false ? `<h1>${title(node)}</h1>` : ""}${content(node)}`;
        const items = rendered.map(label => render(notes.get(label)!)).join("");
        return items ? `${value}<section data-footnotes aria-label="Footnotes"><ol>${items}</ol></section>` : value;
      }
      case "definition": case "strayFence": return "";
      case "linkReference": case "imageReference": {
        const definition = definitions.get(normalizeLabel(node.label ?? ""));
        const link = { href: definition?.url ?? "", ...(typeof definition?.title === "string" ? { title: definition.title } : {}) };
        if (definition && node.type === "linkReference") return element(node, "a", content(node), link);
        if (definition) return `<img${attributes(node, { src: link.href, alt: node.alt ?? "", ...(link.title !== undefined ? { title: link.title } : {}) })}>`;
        // CommonMark's fallback: an unresolved reference is its own source text.
        const suffix = node.referenceType === "full" ? `[${node.label}]` : node.referenceType === "collapsed" ? "[]" : "";
        return node.type === "linkReference" ? `[${content(node)}]${text(suffix)}` : text(`![${node.alt ?? ""}]${suffix}`);
      }
      case "footnoteReference": {
        const label = node.label ?? "";
        if (!notes.has(label)) return text(`[^${label}]`);
        const occurrence = (occurrences.get(label) ?? 0) + 1;
        occurrences.set(label, occurrence);
        return `<sup><a href="#fn:${escapeHtml(label)}" id="fnref:${escapeHtml(label)}${occurrence > 1 ? `:${occurrence}` : ""}" data-footnote-ref>${numbers.get(label)}</a></sup>`;
      }
      case "footnoteDefinition": {
        const label = node.label ?? "";
        const number = numbers.get(label);
        const backlinks = Array.from({ length: counts.get(label) ?? 0 }, (_, index) => {
          const suffix = index ? `:${index + 1}` : "";
          return ` <a href="#fnref:${escapeHtml(label)}${suffix}" data-footnote-backref aria-label="Back to reference ${number}${index ? `-${index + 1}` : ""}">↩${index ? `<sup>${index + 1}</sup>` : ""}</a>`;
        }).join("");
        // Back-links close the note's last paragraph, or form their own.
        const body = content(node);
        return element(node, "li", body.endsWith("</p>") ? `${body.slice(0, -4)}${backlinks}</p>` : `${body}<p>${backlinks.trimStart()}</p>`, { id: `fn:${label}` });
      }
      case "title": case "literal": return content(node);
      case "text": return node.id !== undefined || Object.keys(node.attributes ?? {}).length ? element(node, "span", content(node)) : content(node);
      case "html": return node.value ?? "";
      case "paragraph": return element(node, "p", content(node));
      case "heading":
        if (!Number.isInteger(node.level) || node.level! < 1 || node.level! > 6) throw new ConversionError("unsupported-html-node", "HTML headings need a level from 1 to 6.");
        return element(node, `h${node.level}`, content(node), anchors && node.id === undefined ? { id: anchors.get(node)! } : {});
      case "strong": return element(node, "strong", content(node));
      case "emphasis": return element(node, "em", content(node));
      case "delete": return element(node, "s", content(node));
      case "underline": return element(node, "u", content(node));
      case "highlight": return element(node, "mark", content(node));
      case "inlineCode": return element(node, "code", text(node.value ?? ""));
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
        const code = element(node, "pre", `<code${node.language ? ` class="language-${escapeHtml(node.language)}"` : ""}>${text(node.value ?? "")}</code>`);
        return node.title ? `<figure>${code}<figcaption>${title(node)}</figcaption></figure>` : code;
      }
      case "group": return element(node, node.display === "inline" ? "span" : "div", content(node));
      case "lineBlock": return element(node, "div", content(node), { "data-type": "line-block", style: "white-space:pre-line" });
      case "inline": case "leaf": return element(node, node.type === "leaf" && node.subType === "toc" ? "nav" : "span", `${title(node)}${content(node)}`, { ...(node.subType !== undefined ? { "data-type": node.subType } : {}), ...(node.ref !== undefined ? { "data-ref": node.ref } : {}) });
      case "container": {
        if (node.subType === "layout") return layout(node);
        const heading = title(node);
        if (node.subType === "details") return element(node, "details", `${node.title ? `<summary>${heading}</summary>` : ""}${content(node)}`);
        if (node.subType === "figure") return element(node, "figure", `${content(node)}${node.title ? `<figcaption>${heading}</figcaption>` : ""}`);
        // A generic container is a plain div; it has no semantic type to name.
        if (node.subType === undefined) return element(node, "div", `${node.title ? `<header>${heading}</header>` : ""}${content(node)}`);
        return element(node, "section", `${node.title ? `<header>${heading}</header>` : ""}${content(node)}`, { "data-type": node.subType });
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
  const html = sanitizeHtml(render(document), diagnostics, options.trustedHtml);
  // oxlint-disable-next-line no-control-regex -- the markers are control characters by design.
  return hook ? html.replace(/\u0002([^\u0002\u0003]*)\u0003/g, (_run, run: string) => hook(run)).replace(/[\u0002\u0003]/g, "") : html;
}
