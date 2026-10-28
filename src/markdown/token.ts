// One entry in the block or inline token stream the readers produce.
export type Attr = [string, string | number];

export class Token {
  type: string;
  tag: string;
  attrs: Attr[] | null = null;
  /** Source lines `[begin, end)` of a block token. */
  map: [number, number] | null = null;
  /** 1 opens, -1 closes, 0 stands alone. */
  nesting: -1 | 0 | 1;
  level = 0;
  children: Token[] | null = null;
  content = "";
  markup = "";
  info = "";
  // Rule-specific data, such as a link's authored target or a node a rule built.
  meta: Record<string, unknown> | null = null;
  block = false;
  hidden = false;
  constructor(type: string, tag: string, nesting: -1 | 0 | 1) {
    this.type = type; this.tag = tag; this.nesting = nesting;
  }
  attrGet(name: string): string | number | null {
    for (const attr of this.attrs ?? []) if (attr[0] === name) return attr[1];
    return null;
  }
}
