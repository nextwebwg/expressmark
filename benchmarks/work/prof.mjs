const root=process.argv[2];
const {parse,stringify}=await import(root+"/dist/index.js");
import { readFileSync } from "node:fs";
const guide=readFileSync(new URL("../fixtures/prose.md",import.meta.url),"utf8");
const text=Array.from({length:20},()=>guide).join("\n\n");
const doc=parse(text);
for(const [name,fn] of [["parse",()=>parse(text)],["stringify",()=>stringify(doc)]]) {
  for(let i=0;i<30;i++) fn();
  const t=performance.now(); for(let i=0;i<150;i++) fn(); console.log(name,((performance.now()-t)/150).toFixed(2),"ms");
}
