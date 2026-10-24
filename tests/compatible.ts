import { parse, stringify, type ConversionOptions, type Document } from "../src/index.js";

// Fixtures written for CommonMark/GFM explicitly choose that syntax. Keeping
// both boundaries explicit prevents writer-added frontmatter from disguising
// a parser-default regression; syntax.test.ts exercises the public default.
export const parseCompatible = (source: string, options: ConversionOptions = {}): Document => parse(source, {syntax:"compatible", ...options});
export const stringifyCompatible = (document: Document, options: ConversionOptions = {}): string => stringify({...document, syntax:document.syntax ?? "compatible"}, {syntax:"compatible", ...options});
