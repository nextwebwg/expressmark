// The Markdown lexicon: Parseman grammars recognizing each construct at a
// source position. The block and inline readers ask these grammars what
// starts at a line or a character; the readers then apply CommonMark's
// context-sensitive rules (container continuation, laziness, delimiter
// pairing, reference resolution) to what the grammars report.
import { choice, literal, many, not, peek, regex, sequence, transform, type Combinator, type ParseContext } from "parseman";

const context: ParseContext = { trackLines: false };
const lineEnd = choice(peek(literal("\n")), not(regex(/[\s\S]/)));

/** Run `grammar` at `pos`; its value, or undefined when it does not match there. */
export function match<T>(grammar: Combinator<T>, input: string, pos: number): T | undefined {
  const result = grammar.parse(input, pos, context);
  return result.ok ? result.value : undefined;
}
/** The end offset `grammar` reaches from `pos`, or -1. */
export function reach(grammar: Combinator<unknown>, input: string, pos: number): number {
  const result = grammar.parse(input, pos, context);
  return result.ok ? result.span.end : -1;
}

// ---- Block starts. Each runs at a line's first non-indentation character.

/** A code fence: its run and the rest of the line; a backtick fence's info holds no backtick. */
export const fenceOpen: Combinator<{ markup: string; info: string }> = choice(
  transform(sequence(regex(/`{3,}/), regex(/[^`\n]*/), lineEnd), ([markup, info]) => ({ markup, info })),
  transform(sequence(regex(/~{3,}/), regex(/[^\n]*/)), ([markup, info]) => ({ markup, info })),
);
/** A closing fence: a marker run and trailing spaces only. */
export const fenceClose: Combinator<string> = transform(sequence(regex(/`+|~+/), regex(/[ \t]*/), lineEnd), ([run]) => run);

/** An ATX heading's level and its content's bounds, without a closing sequence. */
export const atxHeading: Combinator<{ level: number; start: number; end: number }> = transform(
  sequence(regex(/#{1,6}(?=[ \t\n]|$)/), regex(/[^\n]*/)),
  ([marks, rest], span) => {
    const start = span.start + marks.length;
    let end = span.end;
    // Trailing spaces, then a `#` run preceded by a space, close the heading.
    while (end > start && (rest.charCodeAt(end - start - 1) === 0x20 || rest.charCodeAt(end - start - 1) === 0x09)) end--;
    let closing = end;
    while (closing > start && rest.charCodeAt(closing - start - 1) === 0x23) closing--;
    if (closing < end && closing > start && (rest.charCodeAt(closing - start - 1) === 0x20 || rest.charCodeAt(closing - start - 1) === 0x09)) end = closing;
    return { level: marks.length, start, end };
  });

/** A thematic break: three or more of one marker, with spaces between. */
export const thematicBreak: Combinator<string> = transform(
  sequence(regex(/(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,}/), lineEnd),
  ([run]) => run.replace(/[ \t]/g, ""));

/** A bullet marker followed by a space, a tab or the line end. */
export const bulletMarker: Combinator<string> = regex(/[*+-](?=[ \t\n]|$)/);
/** An ordered marker: one to nine digits and `.` or `)`, then a space, a tab or the line end. */
export const orderedMarker: Combinator<string> = regex(/[0-9]{1,9}[.)](?=[ \t\n]|$)/);

/** A setext underline: a run of `=` or `-` and trailing spaces. */
export const setextUnderline: Combinator<string> = transform(sequence(regex(/=+|-+/), regex(/[ \t]*/), lineEnd), ([run]) => run);

/** A table delimiter row: its column alignments, or undefined when a column is not a delimiter. */
export const tableDelimiterRow: Combinator<string[] | undefined> = transform(
  regex(/[|:-][|:\- \t][|:\- \t]*(?=\n|$)/),
  (row) => {
    if (row.charCodeAt(0) === 0x2d && (row.charCodeAt(1) === 0x20 || row.charCodeAt(1) === 0x09)) return undefined;
    const columns = row.split("|");
    const aligns: string[] = [];
    for (let i = 0; i < columns.length; i++) {
      const cell = columns[i]!.trim();
      if (!cell) { if (i === 0 || i === columns.length - 1) continue; return undefined; }
      if (!/^:?-+:?$/.test(cell)) return undefined;
      aligns.push(cell.endsWith(":") ? cell.startsWith(":") ? "center" : "right" : cell.startsWith(":") ? "left" : "");
    }
    return aligns;
  });

/** A table row's cells: `|` separates them unless a backslash precedes it, and `\|` keeps only the pipe. */
export const tableCells: Combinator<string[]> = transform(
  sequence(regex(/(?:[^|\\\n]|\\\||\\(?!\|))*/), many(sequence(literal("|"), regex(/(?:[^|\\\n]|\\\||\\(?!\|))*/)))),
  ([first, rest]) => [first, ...rest.map(([, cell]) => cell)].map(cell => cell.includes("\\|") ? cell.replaceAll("\\|", "|") : cell));

const blockNames = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const attribute = String.raw`\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\s*=\s*(?:[^"'=<>${"`"}\x00-\x20]+|'[^']*'|"[^"]*"))?`;
const openTagSource = String.raw`<[A-Za-z][A-Za-z0-9\-]*(?:${attribute})*\s*\/?>`;
const closeTagSource = String.raw`<\/[A-Za-z][A-Za-z0-9\-]*\s*>`;
/** An HTML open or closing tag, as CommonMark's raw HTML reads one. */
export const htmlTag: Combinator<string> = regex(new RegExp(`${openTagSource}|${closeTagSource}`));

export interface HtmlBlockKind { end: RegExp; interrupts: boolean }
const kind = (end: RegExp, interrupts = true): HtmlBlockKind => ({ end, interrupts });
/** CommonMark's seven HTML block starts, each with the line test that ends it. */
export const htmlBlockStart: Combinator<HtmlBlockKind> = choice(
  transform(regex(/<(?:script|pre|style|textarea)(?=\s|>|$)/i), () => kind(/<\/(script|pre|style|textarea)>/i)),
  transform(literal("<!--"), () => kind(/-->/)),
  transform(literal("<?"), () => kind(/\?>/)),
  transform(regex(/<![A-Za-z]/), () => kind(/>/)),
  transform(literal("<![CDATA["), () => kind(/\]\]>/)),
  transform(regex(new RegExp(`</?(?:${blockNames})(?=\\s|/?>|$)`, "i")), () => kind(/^$/)),
  transform(sequence(htmlTag, regex(/\s*$/)), () => kind(/^$/, false)),
  // Block starts are read on one line's text, so `$` ends the line.
);

// ---- Inline constructs. Each runs at the character that may open it.

/** A run of text: everything up to the next character that may begin syntax. */
export const textRun: Combinator<string> = regex(/[^\n!#$%&*+\-:<=>@[\\\]^_`{}~]+/);
// oxlint-disable-next-line no-control-regex -- CommonMark excludes ASCII controls from autolinks.
const autolinkUrl = regex(/[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\x00-\x20]*/);
const autolinkEmail = regex(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*/);
/** `<url>` or `<email>`: the address and whether it is an email. */
export const autolink: Combinator<{ address: string; email: boolean }> = choice(
  transform(sequence(literal("<"), autolinkUrl, literal(">")), ([, address]) => ({ address, email: false })),
  transform(sequence(literal("<"), autolinkEmail, literal(">")), ([, address]) => ({ address, email: true })),
);

/** A character reference as written, with its code point when it is numeric. */
export const entity: Combinator<{ text: string; code?: number }> = choice(
  transform(regex(/&#(?:x[a-f0-9]{1,6}|[0-9]{1,7});/i), text => ({ text, code: text[2] === "x" || text[2] === "X" ? parseInt(text.slice(3, -1), 16) : parseInt(text.slice(2, -1), 10) })),
  transform(regex(/&[a-z][a-z0-9]{1,31};/i), text => ({ text })),
);

/** A link destination: `<…>` without line breaks or `<`, or a run with balanced parentheses. */
export const angleDestination: Combinator<string> = transform(sequence(literal("<"), regex(/(?:[^\n<>\\]|\\[\s\S])*/), literal(">")), ([, value]) => value);
