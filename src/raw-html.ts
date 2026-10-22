// HTML elements that begin a block run to their matching closing tag. This
// reads only as much HTML as that needs: tags, quoted attribute values,
// comments, declarations and the raw-text elements whose content holds no tags.
const voids = new Set(["area","base","br","col","embed","hr","img","input","link","meta","source","track","wbr"]);
const rawText = new Set(["script","style","textarea","title","xmp"]);

interface Tag { name: string; end: number; selfClosing: boolean }
/** Read a start tag at `start` (which holds `<`), or nothing when none begins there. */
export function readStartTag(source: string, start: number): Tag | undefined {
  const name = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(source.slice(start, start + 64))?.[1];
  if (!name) return;
  let cursor = start + name.length + 1;
  if (cursor < source.length && !/[\s/>]/.test(source[cursor]!)) return;
  while (cursor < source.length) {
    const char = source[cursor]!;
    if (char === '"' || char === "'") {
      const close = source.indexOf(char, cursor + 1);
      if (close < 0) return;
      cursor = close + 1;
    } else if (char === ">") {
      return { name: name.toLowerCase(), end: cursor + 1, selfClosing: source[cursor - 1] === "/" };
    } else cursor++;
  }
  return;
}

/**
 * The end of the element starting at `start`: just past its matching closing
 * tag, counting nested same-name elements, or just past a void or self-closing
 * start tag. `closed` is false when the source ends first.
 */
export function readElement(source: string, start: number): { name: string; end: number; closed: boolean } | undefined {
  const tag = readStartTag(source, start);
  if (!tag) return;
  if (tag.selfClosing || voids.has(tag.name)) return { name: tag.name, end: tag.end, closed: true };
  const closing = (name: string, from: number) => new RegExp(`</${name}(?=[\\s/>])[^>]*>`, "ig").exec(source.slice(from));
  if (rawText.has(tag.name)) {
    const match = closing(tag.name, tag.end);
    return match ? { name: tag.name, end: tag.end + match.index + match[0].length, closed: true } : { name: tag.name, end: source.length, closed: false };
  }
  let depth = 1;
  let cursor = tag.end;
  while (cursor < source.length) {
    const next = source.indexOf("<", cursor);
    if (next < 0) break;
    const rest = source.slice(next, next + 9);
    const skip = (terminator: string) => { const close = source.indexOf(terminator, next + 2); return close < 0 ? source.length : close + terminator.length; };
    if (rest.startsWith("<!--")) { cursor = skip("-->"); continue; }
    if (rest.startsWith("<![CDATA[")) { cursor = skip("]]>"); continue; }
    if (rest.startsWith("<!") || rest.startsWith("<?")) { cursor = skip(">"); continue; }
    const end = /^<\/([A-Za-z][A-Za-z0-9-]*)[^>]*>/.exec(source.slice(next, next + 256));
    if (end) {
      if (end[1]!.toLowerCase() === tag.name && --depth === 0) return { name: tag.name, end: next + end[0].length, closed: true };
      cursor = next + end[0].length; continue;
    }
    const inner = readStartTag(source, next);
    if (!inner) { cursor = next + 1; continue; }
    if (inner.name === tag.name && !inner.selfClosing) depth++;
    if (rawText.has(inner.name) && !inner.selfClosing) {
      const match = closing(inner.name, inner.end);
      cursor = match ? inner.end + match.index + match[0].length : source.length;
    } else cursor = inner.end;
  }
  return { name: tag.name, end: source.length, closed: false };
}

export interface RawSegment { kind: "html"; value: string }
export interface FencedSegment { kind: "fenced"; open: string; close: string; markdown: string; attributes: string }
/**
 * Split an element's raw source at fenced content: a line holding a colon run of
 * three or more, at any indentation, and optionally attribute lists that
 * `isAttributes` accepts, opens it; the next line holding only the same run
 * closes it. Enclosed lines lose the opening fence's indentation. `codeLines`
 * reports lines inside code or nested elements, which cannot close it.
 */
export function splitFenced(raw: string, codeLines: (markdown: string) => Set<number>, isAttributes: (source: string) => boolean): { segments: (RawSegment | FencedSegment)[]; unclosed: boolean } {
  const lines = raw.split("\n");
  const segments: (RawSegment | FencedSegment)[] = [];
  let html: string[] = [];
  let unclosed = false;
  for (let index = 0; index < lines.length; index++) {
    const open = /^([ \t]*)(:{3,})[ \t]*(.*?)[ \t]*$/.exec(lines[index]!);
    // The element's first and last lines hold its tags, not fences. A type word
    // after the fence leaves the line raw: only attribute lists may follow.
    if (!open || index === 0 || index === lines.length - 1 || open[3] && !isAttributes(open[3])) { html.push(lines[index]!); continue; }
    const indent = open[1]!;
    const dedent = (line: string) => line.startsWith(indent) ? line.slice(indent.length) : line.trimStart();
    const candidate = lines.slice(index + 1, lines.length - 1).map(dedent);
    const literal = codeLines(candidate.join("\n"));
    let close = -1;
    for (let offset = 0; offset < candidate.length; offset++) {
      if (literal.has(offset)) continue;
      if (new RegExp(`^[ \\t]*${open[2]}[ \\t]*$`).test(lines[index + 1 + offset]!)) { close = offset; break; }
    }
    if (close < 0) { unclosed = true; html.push(lines[index]!); continue; }
    if (html.length) segments.push({ kind: "html", value: html.join("\n") });
    html = [];
    segments.push({ kind: "fenced", open: lines[index]!, close: lines[index + 1 + close]!, markdown: candidate.slice(0, close).join("\n"), attributes: open[3]! });
    index += close + 1;
  }
  if (html.length) segments.push({ kind: "html", value: html.join("\n") });
  return { segments, unclosed };
}
