import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { joinBase } from "../shared/base.ts";

/** Vite がビルドの出力先に作成する、manifest を置くディレクトリの名前である。 */
export const MANIFEST_DIR = ".vite";

/** Vite の manifest の項目のうち、使用する欄を表す。 */
interface ManifestChunk {
  readonly file: string;
  readonly imports?: readonly string[];
}

/** クライアントのビルドが出力したファイルの URL を返す関数の組を表す。 */
export interface ClientAssets {
  /** ルートからの相対パスの要素のファイル `file` の、モジュールの URL と、静的に import するチャンクの URL を返す。 */
  readonly element: (file: string) => {
    readonly module: string;
    readonly chunks: readonly string[];
  };
  /** 絶対パスの CSS のファイル `path` から、要素のシートとして出力した CSS の URL を返す。 */
  readonly sheet: (path: string) => string;
}

/**
 * ルート `root` のアプリのクライアントのビルドの出力先 `outDir` の manifest を読み込み、アプリを配置するパス `base` で始まるファイルの URL を返す関数の組を返す。
 * manifest に無いファイルの URL を求めると、関数はエラーを投げる。
 */
export function readClientAssets(outDir: string, root: string, base: string): ClientAssets {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const manifest = JSON.parse(
    readFileSync(join(outDir, MANIFEST_DIR, "manifest.json"), "utf8"),
  ) as Readonly<Record<string, ManifestChunk>>;
  const chunksOf = (key: string, seen: Set<string>): string[] =>
    (manifest[key]?.imports ?? []).flatMap((imported) => {
      if (seen.has(imported)) return [];
      seen.add(imported);
      const chunk = manifest[imported];
      return chunk ? [joinBase(base, chunk.file)].concat(chunksOf(imported, seen)) : [];
    });
  const files = new Map(
    Object.entries(manifest).map(([key, chunk]) => [
      resolve(root, key),
      joinBase(base, chunk.file),
    ]),
  );
  return {
    element: (file) => {
      const entry = manifest[file];
      if (!entry) {
        throw new Error(
          `[sobria] 要素のファイル ${file} が、クライアントのビルドの manifest にありません。`,
        );
      }
      return { module: joinBase(base, entry.file), chunks: chunksOf(file, new Set([file])) };
    },
    sheet: (path) => {
      const url = files.get(resolve(path));
      if (url === undefined) {
        throw new Error(
          `[sobria] with { type: 'css' } で読み込んだ ${path} が、クライアントのビルドの manifest にありません。要素のファイルから読み込んでください。`,
        );
      }
      return url;
    },
  };
}
