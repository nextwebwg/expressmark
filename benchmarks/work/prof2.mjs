const root=process.argv[2];
const {parse}=await import(root+"/dist/index.js");
import { readFileSync } from "node:fs";
const text=readFileSync(new URL("../fixtures/prose.md",import.meta.url),"utf8").repeat(64);
for(let i=0;i<20;i++) parse(text);
const runs=[];for(let r=0;r<7;r++){const t=performance.now(); for(let i=0;i<20;i++) parse(text); runs.push((performance.now()-t)/20);}
runs.sort((a,b)=>a-b); console.log(root.split("/").pop(), "median", runs[3].toFixed(2), "ms");
