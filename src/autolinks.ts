import { createLinkify } from "./markdown/engine.js";

// GFM recognizes www-prefixed links, while the link detector leaves fuzzy URLs
// off. Reading and literal-text writing share these exact URL boundaries.
export const autolinks = createLinkify().add("www.", {
  validate(text,position,self) {
    const length=self.testSchemaAt(`//www.${text.slice(position)}`,"http:",0);
    return length>6 ? length-6:0;
  },
  normalize(match) { match.url=`http://${match.raw}`; },
});
