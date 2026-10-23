import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Vite の manifest の項目のうち、使用する欄を表す。 */
interface ManifestChunk {
  readonly file: string;
  readonly imports?: readonly string[];
}

/** クライアントのビルドの manifest から、要素のファイルのモジュールの URL と、静的に import するチャンクの URL を返す関数を表す。 */
export type ClientAssets = (file: string) => {
  readonly module: string;
  readonly chunks: readonly string[];
};

/** クライアントのビルドの出力先 `outDir` の manifest を読み込み、ルートからの相対パスのファイルの URL を返す関数を返す。 */
export function readClientAssets(outDir: string): ClientAssets {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const manifest = JSON.parse(
    readFileSync(join(outDir, ".vite/manifest.json"), "utf8"),
  ) as Readonly<Record<string, ManifestChunk>>;
  const chunksOf = (key: string, seen: Set<string>): string[] =>
    (manifest[key]?.imports ?? []).flatMap((imported) => {
      if (seen.has(imported)) return [];
      seen.add(imported);
      const chunk = manifest[imported];
      return chunk ? [`/${chunk.file}`].concat(chunksOf(imported, seen)) : [];
    });
  return (file) => {
    const entry = manifest[file];
    if (!entry) {
      throw new Error(
        `[rinka] 要素のファイル ${file} が、クライアントのビルドの manifest にありません。`,
      );
    }
    return { module: `/${entry.file}`, chunks: chunksOf(file, new Set([file])) };
  };
}
