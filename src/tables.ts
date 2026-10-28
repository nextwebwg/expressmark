import type { Token } from "./markdown/engine.js";
import type { Node } from "./types.js";
import { ConversionError } from "./types.js";

interface Block { token: Token; children: Block[] }
function blockTree(tokens: Token[]): Block[] {
  const root: Block[]=[];
  const stack=[root];
  for(const token of tokens) {
    if(token.nesting === -1) { stack.pop(); continue; }
    const node={token,children:[]};
    stack.at(-1)!.push(node);
    if(token.nesting === 1) stack.push(node.children);
  }
  return root;
}

class TableSyntaxError extends Error {}
function invalid(message: string): never { throw new TableSyntaxError(message); }

// Remove structural indentation in visual columns, leaving tabs in code alone.
function dedent(line: string, width: number): string {
  let column=0, index=0;
  while(index<line.length && column<width && /[ \t]/.test(line[index]!)) {
    column=line[index] === "\t" ? column+4-column%4:column+1;
    index++;
  }
  return " ".repeat(Math.max(0,column-width))+line.slice(index);
}
function itemSource(source: string, item: Block): string {
  const map=item.token.map!;
  const lines=source.split("\n").slice(map[0],map[1]);
  const opening=/^( *)([-+*])([ \t]*)(.*)$/.exec(lines[0] ?? "");
  if(!opening) invalid("Structural rows and cells must be unordered list items.");
  const prefix=opening[1]!+opening[2]!+opening[3]!;
  let width=0;
  for(const char of prefix) width=char === "\t" ? width+4-width%4:width+1;
  const markerWidth=opening[1]!.length+1;
  const padding=width-markerWidth;
  width=markerWidth+(padding>4 ? 1:Math.max(1,padding));
  const content=[dedent(lines[0]!.slice(markerWidth),width-markerWidth),...lines.slice(1).map(line=>dedent(line,width))].join("\n");
  if(/^\[[ xX]\][ \t]+/.test(content)) invalid("Structural rows and cells cannot be task items.");
  return content;
}
export function readTableField(line: string): {name: string; value: string} | undefined {
  for(let index=0;index<line.length;index++) {
    if(line[index] === "\\") { index++; continue; }
    if(line[index] !== ":" || !/[ \t]|^$/.test(line[index+1] ?? "")) continue;
    const name=line.slice(0,index).replace(/\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g,"$1").replace(/^[ \t]+|[ \t]+$/g,"");
    if(!name) return;
    return {name,value:line.slice(index+1).replace(/^[ \t]+/,"")};
  }
  return;
}
function namedFields(source: string): Map<string,string> {
  const result=new Map<string,string>();
  let name: string | undefined;
  let body: string[]=[];
  let fence: string | undefined;
  const finish=()=> { if(name !== undefined) result.set(name,body.join("\n")); };
  for(const line of source.split("\n")) {
    let content: string;
    if(!fence && line && !/^[ \t]/.test(line)) {
      const next=readTableField(line);
      if(!next) invalid("A line at field-label indentation must begin a field.");
      finish();
      if(result.has(next.name)) invalid(`Repeated table field ${next.name}.`);
      name=next.name; body=[]; content=next.value;
    } else content=dedent(line,2);
    body.push(content);
    const marks=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    if(marks) {
      if(!fence && !(marks[1]![0] === "`" && marks[2]!.includes("`"))) fence=marks[1];
      else if(fence && marks[1]![0] === fence[0] && marks[1]!.length>=fence.length && !marks[2]!.trim()) fence=undefined;
    }
  }
  finish();
  return result;
}

/** Consume source controls once; cell bodies use the same Markdown parser as the document. */
export function readListTable(container: Node, source: string, read: (source: string)=>Token[], parseBlocks: (source: string)=>Node[]): Node | string {
  try {
    const attributes={...container.attributes};
    for(const key of ["header","transpose"]) if(attributes[key] !== undefined && typeof attributes[key] !== "boolean") invalid(`${key} must be a boolean flag.`);
    const root=blockTree(read(source));
    const rows: Node[]=[];
    const markers: string[][]=[];
    const names: string[]=[];
    let named=false;
    function cell(value: string): Node {
      const body=parseBlocks(value);
      const first=body[0];
      if(!body.length) return {type:"tableCell",value:""};
      if(body.length === 1 && first?.type === "paragraph" && Object.keys(first).every(key=>["type","value","children"].includes(key))) return {...first,type:"tableCell"};
      return {type:"tableCell",body};
    }
    if(root.length) {
      // Blank lines between rows keep one table, though `standard` syntax splits the list there.
      if(root.some(block=>block.token.type !== "bullet_list_open")) invalid("A table body must contain one unordered list.");
      for(const [index,item] of root.flatMap(list=>list.children).entries()) {
        const value=itemSource(source,item);
        const firstLine=value.split("\n")[0]!;
        const isNamed=!/^(?:[-+*])(?:[ \t]|$)/.test(firstLine) && Boolean(readTableField(firstLine));
        if(index === 0) named=isNamed;
        if(isNamed) {
          if(!named) invalid("Named records cannot follow an unnamed positional row.");
          const values=namedFields(value);
          for(const name of values.keys()) if(!names.includes(name)) names.push(name);
          rows.push({type:"tableRow",children:names.map(name=>cell(values.get(name) ?? ""))});
          markers.push(names.map(()=>""));
        } else {
          const tree=blockTree(read(value));
          if(tree.length !== 1 || tree[0]!.token.type !== "bullet_list_open") invalid("A positional row must contain exactly one unordered cell list.");
          const values=tree[0]!.children.map(item=>itemSource(value,item));
          if(named && values.length>names.length) invalid("A positional row exceeds the established named columns.");
          const raw=values.map(value=>/^[>^]$/.test(value.trim()) ? value.trim():"");
          rows.push({type:"tableRow",children:values.map((value,index)=>raw[index] ? {type:"tableCell",value:""}:cell(value))});
          markers.push(raw);
        }
      }
    }
    if(named && attributes.header === false) invalid("Named records require their implicit header.");
    const width=named ? names.length:Math.max(0,...rows.map(row=>row.children!.length));
    const hasMerges=markers.some(row=>row.some(Boolean));
    for(const [index,row] of rows.entries()) {
      if(hasMerges && !named && row.children!.length !== width) invalid("Merged rows must explicitly provide every grid slot.");
      while(row.children!.length<width) row.children!.push({type:"tableCell",value:""});
      while(markers[index]!.length<width) markers[index]!.push("");
    }
    if(named) {
      rows.unshift({type:"tableRow",children:names.map(value=>({type:"tableCell",header:true,value}))});
      markers.unshift(names.map(()=>""));
    } else if(attributes.header === true) for(const cell of rows[0]?.children ?? []) cell.header=true;
    const table: Node={type:"table",children:rows};
    if(container.id !== undefined) table.id=container.id;
    if(container.title !== undefined) table.title=container.title;
    const error=mergeTable(table,markers);
    if(error) invalid(error);
    const result=attributes.transpose === true ? transposeTable(table):table;
    if(attributes.align !== undefined) {
      if(typeof attributes.align !== "string") invalid("Table alignment must be a comma-separated string.");
      const align=attributes.align.split(",").map(value=>value.trim());
      if(align.some(value=>!["start","center","end","-"].includes(value))) invalid("Unknown table alignment.");
      const displayedWidth=attributes.transpose === true ? rows.length:width;
      if(align.length !== 1 && (!displayedWidth || align.length !== displayedWidth)) invalid("Alignment count must match the displayed width.");
      result.align=Array.from({length:displayedWidth},(_,index)=>align[align.length === 1 ? 0:index] === "-" ? null:align[align.length === 1 ? 0:index] as "start"|"center"|"end");
    }
    delete attributes.header; delete attributes.transpose; delete attributes.align;
    if(Object.keys(attributes).length) result.attributes=attributes;
    // Positional rows with a header row are a second spelling of named fields.
    // Recorded only where named fields could spell the table instead.
    const labels=rows[0]?.children?.map(cell=>cell.value) ?? [];
    if(!named && container.attributes?.transpose !== true && rows.length>1 && !hasMerges && rows[0]!.children!.every(cell=>cell.header)
      && labels.every(value=>typeof value === "string" && Boolean(value.trim()) && !/[\r\n]/.test(value) && value.trim() === value) && new Set(labels).size === labels.length) result.source={...result.source,form:"positional"};
    return result;
  } catch(error) {
    if(error instanceof TableSyntaxError) return error.message;
    throw error;
  }
}

/** Grid slots reference originating cells; covered slots never create AST identities. */
export function tableGrid(table: Node): Node[][] {
  const rows=table.children ?? [];
  const width=table.align?.length ?? rows[0]?.children?.reduce((sum,cell)=>sum+(cell.colSpan ?? 1),0) ?? 0;
  const grid=rows.map(()=>Array<Node|undefined>(width).fill(undefined));
  const fail=(): never=> { throw new ConversionError("unsupported-conversion","Invalid table span rectangle or incomplete table grid."); };
  if(rows.length && !width) fail();
  for(const [r,row] of rows.entries()) {
    if(row.type !== "tableRow") fail();
    let c=0;
    for(const cell of row.children ?? []) {
      if(cell.type !== "tableCell") fail();
      while(c<width && grid[r]![c]) c++;
      const w=cell.colSpan ?? 1,h=cell.rowSpan ?? 1;
      if(!Number.isInteger(w) || !Number.isInteger(h) || w<1 || h<1 || c+w>width || r+h>rows.length) fail();
      for(let y=r;y<r+h;y++) for(let x=c;x<c+w;x++) {
        if(grid[y]![x]) fail();
        grid[y]![x]=cell;
      }
      c+=w;
    }
    if(grid[r]!.some(cell=>!cell)) fail();
  }
  return grid as Node[][];
}

export function transposeTable(table: Node): Node {
  const grid=tableGrid(table);
  const rows: Node[]=Array.from({length:grid[0]?.length ?? 0},()=>({type:"tableRow",children:[]}));
  const seen=new Set<Node>();
  for(let column=0;column<rows.length;column++) for(let r=0;r<grid.length;r++) {
    const cell=grid[r]![column]!;
    if(seen.has(cell)) continue;
    seen.add(cell);
    const transposed={...cell};
    delete transposed.colSpan; delete transposed.rowSpan;
    if(cell.rowSpan !== undefined) transposed.colSpan=cell.rowSpan;
    if(cell.colSpan !== undefined) transposed.rowSpan=cell.colSpan;
    rows[column]!.children!.push(transposed);
  }
  const transposed={...table,children:rows};
  delete transposed.align;
  return transposed;
}

export function mergeTable(table: Node, sources: string[][]): string | undefined {
  const rows=table.children ?? [];
  const width=rows[0]?.children?.length ?? 0;
  const grid: (Node|undefined)[][]=rows.map(()=>Array<Node|undefined>(width));
  for(let r=0;r<rows.length;r++) {
    const row=rows[r]!; const cells=row.children ?? []; const result:Node[]=[];
    for(let c=0;c<width;c++) {
      const marker=sources[r]?.[c]?.trim();
      if(marker === "^") {
        const above=grid[r-1]?.[c];
        if(!above || Boolean(above.header) !== Boolean(cells[c]?.header)) return "A vertical merge needs a cell above within the same header/body region.";
        grid[r]![c]=above;
        continue;
      }
      if(marker === ">") {
        let next=c; while(sources[r]?.[next]?.trim() === ">") next++;
        if(next >= width || sources[r]?.[next]?.trim() === "^") return "A horizontal merge must end at ordinary content.";
        const cell=cells[next]!; cell.colSpan=next-c+1;
        for(let slot=c;slot<=next;slot++) grid[r]![slot]=cell;
        result.push(cell); c=next;
      } else { const cell=cells[c]!; result.push(cell); grid[r]![c]=cell; }
    }
    const counts=new Map<Node,number>();
    for(let c=0;c<width;c++) if(sources[r]?.[c]?.trim() === "^") {
      const cell=grid[r]![c]!; counts.set(cell,(counts.get(cell) ?? 0)+1);
    }
    for(const [cell,count] of counts) {
      if(count !== (cell.colSpan ?? 1)) return "Vertical continuations must cover the full cell width.";
      cell.rowSpan=(cell.rowSpan ?? 1)+1;
    }
    row.children=result;
  }
  return;
}
