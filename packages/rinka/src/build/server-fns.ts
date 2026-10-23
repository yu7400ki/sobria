import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import { langs } from "./ast.ts";
import { transformSource } from "./compiler.ts";

/** サーバー関数を定義できるファイルを置く、アプリのルートからの相対パスのディレクトリである。 */
const SERVER_FN_DIR = "src";

/** ファイルのパス `file` を、パスの SHA-256 を base64url にした値の先頭 10 文字に `m` を付けた値にする。 */
export const hashedFnModule = (file: string): string =>
  `m${createHash("sha256").update(file).digest("base64url").slice(0, 10)}`;

/** アプリのルートからの相対パス `file` のファイルで、サーバー関数を定義できるかどうかを返す。 */
export const isServerFnSource = (file: string): boolean =>
  file.startsWith(`${SERVER_FN_DIR}/`) && extname(file) in langs && !file.endsWith(".d.ts");

/** アプリのルート `root` で、サーバー関数を定義したファイルを走査し、ID のモジュールの部分からルートからの相対パスへの対応を返す。 */
export function serverFnModules(root: string): Map<string, string> {
  const modules = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") visit(path);
        continue;
      }
      const file = relative(root, path).split(sep).join("/");
      if (!isServerFnSource(file)) continue;
      const code = readFileSync(path, "utf8");
      if (!code.includes("defineServerFn")) continue;
      const fnModule = hashedFnModule(file);
      const lang = langs[extname(file)]!;
      const { serverFns } = transformSource(code, {
        id: path,
        file,
        lang,
        client: false,
        fnModule,
      });
      if (serverFns.length > 0) modules.set(fnModule, file);
    }
  };
  const start = join(root, SERVER_FN_DIR);
  if (existsSync(start)) visit(start);
  return new Map([...modules].toSorted(([, a], [, b]) => (a < b ? -1 : 1)));
}
