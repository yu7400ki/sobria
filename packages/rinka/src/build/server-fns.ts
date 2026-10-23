import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import type { Lang } from "./ast.ts";
import { transformSource } from "./compiler.ts";

/** 本番のビルドで、ファイルのパス `file` から、サーバー関数の ID のモジュールの部分を返す。 */
export const hashedFnModule = (file: string): string =>
  `m${createHash("sha256").update(file).digest("base64url").slice(0, 10)}`;

/** 拡張子ごとの、変換する言語である。 */
const langs: Readonly<Record<string, Lang>> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
};

/**
 * アプリのルート `root` の中で、サーバー関数を定義したモジュールを走査し、ID のモジュールの部分からルートからの相対パスへの対応を返す。
 * `node_modules`、`.` で始まる名前のディレクトリ、`skip` のディレクトリの中は走査しない。
 */
export function serverFnModules(root: string, skip: readonly string[]): Map<string, string> {
  const modules = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".") || skip.includes(path)) {
          continue;
        }
        visit(path);
        continue;
      }
      const lang = langs[extname(entry.name)];
      if (!lang || entry.name.endsWith(".d.ts")) continue;
      const code = readFileSync(path, "utf8");
      if (!code.includes("defineServerFn")) continue;
      const file = relative(root, path).split(sep).join("/");
      const fnModule = hashedFnModule(file);
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
  visit(root);
  return modules;
}
