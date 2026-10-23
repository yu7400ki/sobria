import { existsSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

import { tagFromPath } from "../shared/names.ts";
import { inside } from "./paths.ts";

/** 要素のファイルのパスと、タグ名を表す。 */
export interface ElementFile {
  readonly path: string;
  readonly tag: string;
}

/**
 * パス `path` のファイルが、要素のディレクトリ `dir` の中の要素のファイルなら、接頭辞 `prefix` を付けたタグ名を返す。
 * 要素のファイルは、拡張子が `.tsx` か `.jsx` のファイルのうち、名前が `_` で始まらず、`_` で始まる名前のディレクトリの中にも無いファイルである。
 */
export function elementTag(prefix: string, dir: string, path: string): string | undefined {
  if (!/\.[jt]sx$/.test(path)) return undefined;
  const inner = inside(dir, path);
  if (inner === undefined || inner.split("/").some((part) => part.startsWith("_"))) {
    return undefined;
  }
  return tagFromPath(prefix, inner);
}

/** 要素のディレクトリ `dir` の中の要素のファイルを、パスの順に返す。2 つのファイルが同じタグになれば、エラーを投げる。 */
export function scanElements(prefix: string, dir: string): ElementFile[] {
  if (!existsSync(dir)) return [];
  const owners = new Map<string, string>();
  const elements: ElementFile[] = [];
  const entries = readdirSync(dir, { recursive: true, encoding: "utf8" }).map((entry) =>
    entry.split(sep).join("/"),
  );
  for (const entry of entries.toSorted()) {
    const path = join(dir, entry);
    const tag = elementTag(prefix, dir, path);
    if (tag === undefined) continue;
    const other = owners.get(tag);
    if (other !== undefined) {
      throw new Error(
        `要素のファイル ${other} と ${entry} は、どちらもタグ名 ${tag} になります。どちらかのファイル名を変更してください。`,
      );
    }
    owners.set(tag, entry);
    elements.push({ path, tag });
  }
  return elements;
}
