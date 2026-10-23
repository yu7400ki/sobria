import { isAbsolute, relative, sep } from "node:path";

/** `path` が `dir` の中にあれば、`dir` からの相対パスを `/` で区切って返す。 */
export function inside(dir: string, path: string): string | undefined {
  const inner = relative(dir, path);
  return isAbsolute(inner) || inner === ".." || inner.startsWith(`..${sep}`)
    ? undefined
    : inner.split(sep).join("/");
}
