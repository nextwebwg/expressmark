import type { MarkdownIt } from "markdown-it";

export function configureAutolinks(md: MarkdownIt): void {
  // GFM recognizes www-prefixed links, while linkify-it leaves fuzzy URLs off.
  // Share the reader's exact URL boundaries with literal-text serialization.
  md.linkify.add("www.", {
    validate(text,position,self) {
      const length=self.testSchemaAt(`//www.${text.slice(position)}`,"http:",0);
      return length>6 ? length-6:0;
    },
    normalize(match) { match.url=`http://${match.raw}`; },
  });
}
