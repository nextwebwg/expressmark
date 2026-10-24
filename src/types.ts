/** JSON values accepted in document metadata and application annotations. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Attributes = Record<string, string | boolean>;
export interface Point { line: number; column: number; offset?: number }
export interface Position { start: Point; end: Point }

/** Named content slots follow the official AST; body, children and value are exclusive. */
export interface Node {
  type: string;
  subType?: string;
  id?: string;
  title?: Node | string;
  body?: Node[];
  children?: Node[];
  value?: string;
  attributes?: Attributes;
  position?: Position;
  source?: { [key: string]: Json };
  data?: { [key: string]: Json };
  level?: number;
  ordered?: boolean;
  start?: number;
  tight?: boolean;
  checked?: boolean;
  url?: string;
  alt?: string;
  language?: string;
  meta?: string;
  ref?: string;
  label?: string;
  referenceType?: "full" | "collapsed" | "shortcut";
  /** The authored callout spelling: a colon container (the default) or an alert. */
  spelling?: "container" | "alert";
  /** The authored container title spelling: `[Title]` (the default) or unbracketed text. */
  titleSpelling?: "bracketed" | "unbracketed";
  align?: ("start" | "center" | "end" | null)[];
  header?: boolean;
  colSpan?: number;
  rowSpan?: number;
  display?: "inline" | "block";
  /** A group's element, or an HTML element's tag name. */
  tag?: string;
  /** An HTML element's start tag and closing tag, as written. An unclosed element has no `close`. */
  open?: string;
  close?: string;
}
export interface Document extends Node {
  type: "document";
  version: 1;
  body: Node[];
  title?: Node;
  metadata?: { [key: string]: Json };
  /** The non-default or frontmatter syntax. An absent value means `standard`. */
  syntax?: Syntax;
}
/** `compatible` reads CommonMark 0.31.2 and GFM with the extensions; `standard` reads the Expressive Markdown spec. */
export type Syntax = "compatible" | "standard";
export function validateSyntax(syntax: unknown): void {
  if(syntax !== undefined && syntax !== "compatible" && syntax !== "standard") throw new TypeError("Syntax must be compatible or standard.");
}
export interface Diagnostic {
  code: string;
  message: string;
  severity: "warning";
  /** The lines of the block that holds the construct, for a lint warning. */
  position?: Position;
  /** The preferred form, for a lint warning. */
  preferred?: string;
}
/** `true` turns every lint rule on; a map turns rules on, except those set to `false`. */
export type LintOption = boolean | Readonly<Record<string, boolean>>;
export const linting = (option: LintOption | undefined, code: string): boolean => option === true || typeof option === "object" && option !== null && option[code] !== false;
export interface ConversionOptions {
  onDiagnostic?: (diagnostic: Diagnostic) => void;
  /**
   * Keep raw HTML verbatim as opaque `html` nodes, unfiltered. Only for content
   * the site's own authors write, never user-submitted or third-party content;
   * `renderHtml` still applies its profile and the host's allowlist.
   */
  trustedHtml?: boolean;
  /** The syntax for documents whose frontmatter sets none. Default `standard`. */
  syntax?: Syntax;
  /** `parse`: report spellings other than the preferred form, as lint warnings. */
  lint?: LintOption;
  /** `stringify`: write the preferred form of every spelling the lint rules flag. */
  preferredForms?: boolean;
}
export class ConversionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConversionError";
    this.code = code;
  }
}
export function warn(options: ConversionOptions, code: string, message: string): void {
  options.onDiagnostic?.({ code, message, severity: "warning" });
}
