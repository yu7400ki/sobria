import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { ElementSource } from "./elements.ts";

/** TSX のソースの形で配布された、要素のライブラリを表す。 */
export interface Library extends ElementSource {
  /** パッケージの名前である。 */
  readonly name: string;
}

/** ディレクトリ `dir` から上位に向かって `name` を探し、最初に見つけたパスを返す。見つからなければ undefined を返す。 */
export function findUp(dir: string, name: string): string | undefined {
  const path = join(dir, name);
  if (existsSync(path)) return path;
  const parent = dirname(dir);
  return parent === dir ? undefined : findUp(parent, name);
}

/** パス `path` の JSON のファイルを読み込む。 */
export const readJson = (path: string): Record<string, unknown> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

/**
 * アプリのルート `root` から最も近い `package.json` の `dependencies` と `devDependencies` のうち、
 * `package.json` に `sobria` のフィールドを持つパッケージを、名前の順に返す。
 * `sobria` のフィールドに `prefix` か `elements` の文字列が無ければ、エラーを投げる。
 */
export function findLibraries(root: string): Library[] {
  const manifest = findUp(root, "package.json");
  if (manifest === undefined) return [];
  const json = readJson(manifest);
  const names = [json["dependencies"], json["devDependencies"]].flatMap((deps) =>
    typeof deps === "object" && deps !== null ? Object.keys(deps) : [],
  );
  return [...new Set(names)].toSorted().flatMap((name): Library[] => {
    const found = findUp(dirname(manifest), join("node_modules", name, "package.json"));
    if (found === undefined) return [];
    const { sobria } = readJson(found);
    if (sobria === undefined) return [];
    const field = (key: string): unknown =>
      typeof sobria === "object" && sobria !== null ? Reflect.get(sobria, key) : undefined;
    const prefix = field("prefix");
    const elements = field("elements");
    if (typeof prefix !== "string" || typeof elements !== "string") {
      throw new Error(
        `[sobria] ${name} の package.json の sobria のフィールドには、prefix と elements を文字列で記述してください。`,
      );
    }
    const dir = realpathSync(dirname(found));
    return [{ name, dir, prefix, elementsDir: resolve(dir, elements) }];
  });
}
