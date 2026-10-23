import { existsSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

import { tagFromPath } from "../shared/names.ts";
import { inside } from "./paths.ts";

/** 要素のタグ名の接頭辞と、要素のディレクトリの絶対パスと、要素を所有するパッケージのディレクトリの絶対パスの組を表す。 */
export interface ElementSource {
  readonly prefix: string;
  readonly elementsDir: string;
  readonly dir: string;
}

/** 要素のファイルのパスと、タグ名を表す。 */
export interface ElementFile {
  readonly path: string;
  readonly tag: string;
}

/**
 * パス `path` のファイルが、要素のディレクトリ `dir` の中の要素のファイルなら、接頭辞 `prefix` を付けたタグ名を返す。
 * 要素のファイルは、拡張子が `.tsx` か `.jsx` のファイルのうち、名前が `_` で始まらず、`_` で始まる名前のディレクトリの中にも無いファイルである。
 */
function elementTag(prefix: string, dir: string, path: string): string | undefined {
  if (!/\.[jt]sx$/.test(path)) return undefined;
  const inner = inside(dir, path);
  if (inner === undefined || inner.split("/").some((part) => part.startsWith("_"))) {
    return undefined;
  }
  return tagFromPath(prefix, inner);
}

/** パス `path` のファイルが、`sources` のどれかの要素のディレクトリの中の要素のファイルなら、そのタグ名を返す。 */
export const sourceTag = (sources: readonly ElementSource[], path: string): string | undefined =>
  sources
    .map(({ prefix, elementsDir }) => elementTag(prefix, elementsDir, path))
    .find((tag) => tag !== undefined);

/**
 * `sources` の要素のディレクトリの中の要素のファイルを、ディレクトリごとにパスの順に返す。
 * 2 つのファイルが同じタグになれば、エラーを投げる。
 */
export function scanElements(sources: readonly ElementSource[]): ElementFile[] {
  const owners = new Map<string, string>();
  const elements: ElementFile[] = [];
  for (const { prefix, elementsDir } of sources) {
    if (!existsSync(elementsDir)) continue;
    const entries = readdirSync(elementsDir, { recursive: true, encoding: "utf8" }).map((entry) =>
      entry.split(sep).join("/"),
    );
    for (const entry of entries.toSorted()) {
      const path = join(elementsDir, entry);
      const tag = elementTag(prefix, elementsDir, path);
      if (tag === undefined) continue;
      const other = owners.get(tag);
      if (other !== undefined) {
        throw new Error(
          `要素のファイル ${other} と ${path} は、どちらもタグ名 ${tag} になります。どちらかのファイル名か接頭辞を変更してください。`,
        );
      }
      owners.set(tag, path);
      elements.push({ path, tag });
    }
  }
  return elements;
}
