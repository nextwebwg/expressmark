declare module "punycode.js" {
  const punycode: { toASCII(domain: string): string; toUnicode(domain: string): string };
  export default punycode;
}
