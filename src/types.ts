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
  tag?: "span" | "div";
}
export interface Document extends Node {
  type: "document";
  version: 1;
  body: Node[];
  title?: Node;
  metadata?: { [key: string]: Json };
}
export interface Diagnostic {
  code: string;
  message: string;
  severity: "warning";
}
export interface ConversionOptions {
  onDiagnostic?: (diagnostic: Diagnostic) => void;
  /**
   * Keep raw HTML verbatim as opaque `html` nodes, unfiltered. Only for content
   * the site's own authors write, never user-submitted or third-party content;
   * `renderHtml` still applies its profile and the host's allowlist.
   */
  trustedHtml?: boolean;
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
