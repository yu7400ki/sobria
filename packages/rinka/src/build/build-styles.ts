import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Rolldown } from "vite";

import { joinBase } from "../shared/base.ts";
import { STYLES_MARKER } from "./entry.ts";
import { inside } from "./paths.ts";
import { ROUTES_DIR } from "./routes.ts";

/** チャンクの、Vite が記録した import する CSS のファイル名を表す。 */
type CssMetadata = { readonly viteMetadata?: { readonly importedCss: ReadonlySet<string> } };

/**
 * サーバーのビルドの `bundle` から、ルートのファイルごとに、そのチャンクと静的に import するチャンクが import した CSS の URL を、依存する側を後にして集め、
 * 目印の文字列のリテラルを、引用符の種類に関わらず、その一覧に置き換える。CSS の URL は、アプリを配置するパス `base` で始める。目印が無ければ、エラーを投げる。
 */
export function embedRouteStyles(bundle: Rolldown.OutputBundle, root: string, base: string): void {
  const cssOf = (fileName: string, seen: Set<string>): string[] => {
    if (seen.has(fileName)) return [];
    seen.add(fileName);
    const chunk = bundle[fileName];
    if (chunk?.type !== "chunk") return [];
    const own = [
      ...((chunk as Rolldown.OutputChunk & CssMetadata).viteMetadata?.importedCss ?? []),
    ];
    return chunk.imports
      .flatMap((imported) => cssOf(imported, seen))
      .concat(own.map((file) => joinBase(base, file)));
  };
  const table: Record<string, string[]> = {};
  const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
  for (const chunk of chunks) {
    const file = chunk.facadeModuleId && inside(root, chunk.facadeModuleId);
    if (!file?.startsWith(`${ROUTES_DIR}/`)) continue;
    table[file] = [...new Set(cssOf(chunk.fileName, new Set()))];
  }
  const marker = new RegExp(`(["'\`])${STYLES_MARKER}\\1`);
  const entry = chunks.find((chunk) => marker.test(chunk.code));
  if (!entry) throw new Error("[rinka] サーバーのエントリーに、CSS の一覧の目印がありません。");
  entry.code = entry.code.replace(marker, () => JSON.stringify(table));
}

/** サーバーのビルドの `bundle` のアセットを、ソースマップと JSON を除いて、サーバーの出力先 `serverDir` からクライアントの出力先 `clientDir` に移動する。 */
export function moveServerAssets(
  bundle: Rolldown.OutputBundle,
  serverDir: string,
  clientDir: string,
): void {
  for (const output of Object.values(bundle)) {
    if (output.type !== "asset" || /\.(map|json)$/.test(output.fileName)) continue;
    const target = join(clientDir, output.fileName);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(join(serverDir, output.fileName), target);
  }
}
