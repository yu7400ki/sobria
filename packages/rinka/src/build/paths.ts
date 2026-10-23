import { isAbsolute, relative, sep } from "node:path";

/** `from` から `to` への相対パスを、`/` で区切って返す。 */
export const relativePath = (from: string, to: string): string =>
  relative(from, to).split(sep).join("/");

/** `path` が `dir` の中にあれば、`dir` からの相対パスを `/` で区切って返す。 */
export function inside(dir: string, path: string): string | undefined {
  const inner = relative(dir, path);
  return isAbsolute(inner) || inner === ".." || inner.startsWith(`..${sep}`)
    ? undefined
    : inner.split(sep).join("/");
}

/** ファイル `path` を開発サーバーが配信するパスを返す。`root` の外のファイルは `/@fs/` のパスにする。 */
export function devPath(path: string, root: string): string {
  const file = inside(root, path);
  const absolute = path.replaceAll("\\", "/");
  return file === undefined ? `/@fs${absolute.startsWith("/") ? "" : "/"}${absolute}` : `/${file}`;
}

/** 開発サーバーのパス `path` の CSS を、CSS として配信させる URL を返す。URL に使用できない文字はパーセントエンコードする。 */
export const directUrl = (path: string): string =>
  `${encodeURI(path).replaceAll("#", "%23").replaceAll("?", "%3F")}?direct`;
