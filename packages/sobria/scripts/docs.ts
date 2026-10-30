// ドキュメントサイトの本文の MDX を、パッケージに同梱するディレクトリにコピーする。
import { cpSync, rmSync } from "node:fs";
import { extname, resolve } from "node:path";

/** ドキュメントサイトの本文のディレクトリである。 */
export const docsSource = resolve(import.meta.dirname, "../../docs/src/content");

/** `dest` を空にしてから、ドキュメントサイトの本文の `.mdx` を、ディレクトリの構成のまま `dest` にコピーする。 */
export function copyDocs(dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  cpSync(docsSource, dest, {
    recursive: true,
    filter: (path) => extname(path) === "" || path.endsWith(".mdx"),
  });
}
