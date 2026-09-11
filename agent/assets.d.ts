/** Raw-text asset imports, embedded at compile time by eve. */
declare module "*.html?raw" {
  const content: string;
  export default content;
}
