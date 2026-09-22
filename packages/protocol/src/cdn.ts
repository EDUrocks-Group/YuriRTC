/** Raw npm files only: transformed modules cannot pass the signed byte hash. */
export const CDN_ROOTS = [
  "https://unpkg.com/",
  "https://cdn.jsdelivr.net/npm/",
  "https://esm.sh/",
  "https://unpkg.toolforge.org/",
  "https://s4.zstatic.net/npm/"
];
export function packageUrls(name: string, version: string, file: string): string[] {
  return CDN_ROOTS.map(root => `${root}${name}@${version}/${file}${root === "https://esm.sh/" ? "?raw" : ""}`);
}
