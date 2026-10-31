import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, posix, sep } from "node:path";

import { langs, parseModule } from "./ast.ts";
import { relativePath } from "./paths.ts";
import { findDefinitions, serverFnNames } from "./server-fn-transform.ts";

/** サーバー関数を定義できるファイルを置く、アプリのルートからの相対パスのディレクトリである。 */
const SERVER_FN_DIR = "src";

/** ファイルのパス `file` を、パスの SHA-256 を base64url にした値の先頭 10 文字に `m` を付けた値にする。 */
export const hashedFnModule = (file: string): string =>
  `m${createHash("sha256").update(file).digest("base64url").slice(0, 10)}`;

/** アプリのルートからの相対パス `file` のファイルで、サーバー関数を定義できるかどうかを返す。 */
export const isServerFnSource = (file: string): boolean =>
  file.startsWith(`${SERVER_FN_DIR}/`) &&
  posix.normalize(file) === file &&
  !file.includes("\\") &&
  langs.has(extname(file)) &&
  !file.endsWith(".d.ts");

/** ファイルのパスごとに、最後に解析したソースの SHA-256 と、サーバー関数を定義していたかどうかを保持する。 */
const scanned = new Map<string, { readonly hash: string; readonly defines: boolean }>();

/** パス `path` のファイルのソース `code` が、サーバー関数を定義しているかどうかを返す。前回と同じソースなら、解析せずに前回の結果を返す。 */
function definesServerFn(path: string, file: string, code: string): boolean {
  const hash = createHash("sha256").update(code).digest("base64url");
  const cached = scanned.get(path);
  if (cached?.hash === hash) return cached.defines;
  const defines =
    code.includes("defineServerFn") &&
    serverFnNames(
      findDefinitions(parseModule(code, { id: path, file, lang: langs.get(extname(file))! }), file),
    ).length > 0;
  scanned.set(path, { hash, defines });
  return defines;
}

/** `read` を呼び出した結果を返す。`read` が、ファイルかディレクトリが無いことを示すエラーを投げたら、`undefined` を返す。 */
function unlessMissing<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * アプリのルート `root` で、サーバー関数を定義したファイルを走査し、ルートからの相対パスを文字列の順に返す。
 * 走査の途中で削除されたファイルとディレクトリは、走査の結果に含めない。
 */
export function serverFnModules(root: string): string[] {
  const modules: string[] = [];
  const visited = new Set<string>();
  const visit = (dir: string): void => {
    for (const entry of unlessMissing(() => readdirSync(dir, { withFileTypes: true })) ?? []) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") visit(path);
        continue;
      }
      const file = relativePath(root, path);
      if (!isServerFnSource(file)) continue;
      const code = unlessMissing(() => readFileSync(path, "utf8"));
      if (code === undefined) continue;
      visited.add(path);
      if (definesServerFn(path, file, code)) modules.push(file);
    }
  };
  const start = join(root, SERVER_FN_DIR);
  if (existsSync(start)) visit(start);
  // 走査したディレクトリの中で、無くなったファイルの解析の結果を捨てる
  for (const path of scanned.keys()) {
    if (path.startsWith(start + sep) && !visited.has(path)) scanned.delete(path);
  }
  return modules.toSorted();
}
