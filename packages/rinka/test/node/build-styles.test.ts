import type { Rolldown } from "vite";
import { describe, expect, it } from "vitest";

import { embedRouteStyles } from "../../src/build/build-styles.ts";

/** ファイル名 `fileName` のチャンクを表す、テストで使用する欄だけを持つ値を返す。 */
const chunk = (fileName: string, code: string, extra: object = {}) =>
  ({
    type: "chunk",
    fileName,
    code,
    imports: [],
    facadeModuleId: null,
    ...extra,
  }) as unknown as Rolldown.OutputChunk;

/** ルートのファイル `src/routes/page.tsx` のチャンクが `css` を import し、`entry` のコードが目印を持つ bundle を返す。 */
function bundleOf(entry: string, css: string): Rolldown.OutputBundle {
  return {
    "entry.js": chunk("entry.js", entry),
    "page.js": chunk("page.js", "", {
      facadeModuleId: "/app/src/routes/page.tsx",
      viteMetadata: { importedCss: new Set([css]) },
    }),
  };
}

describe("ルートのファイルごとの CSS の一覧の埋め込み", () => {
  it("圧縮で引用符が変わった目印も一覧に置き換え、CSS のファイル名の $ をそのまま埋め込む", () => {
    for (const quote of ['"', "'", "`"]) {
      const bundle = bundleOf(`const s=${quote}__rinka_route_styles__${quote};`, "assets/a$&b.css");
      embedRouteStyles(bundle, "/app", "/sub/");
      expect((bundle["entry.js"] as Rolldown.OutputChunk).code).toBe(
        'const s={"src/routes/page.tsx":["/sub/assets/a$&b.css"]};',
      );
    }
  });

  it("目印が無ければ、エラーを投げる", () => {
    expect(() => embedRouteStyles(bundleOf("const s = 1;", "assets/a.css"), "/app", "/")).toThrow(
      /目印/,
    );
  });
});
