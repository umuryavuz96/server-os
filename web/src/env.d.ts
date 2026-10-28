// Vite asset imports (the flag SVGs) resolve to their URL.
declare module "*.svg" {
  const src: string;
  export default src;
}
