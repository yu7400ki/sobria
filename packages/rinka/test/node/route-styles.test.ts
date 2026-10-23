import type { EnvironmentModuleNode } from "vite";
import { describe, expect, it } from "vitest";

import { routeStyles } from "../../src/build/route-styles.ts";

/** `id` と `url` と、import するモジュールを持つ、モジュールのグラフのノードを返す。 */
const node = (id: string, imported: EnvironmentModuleNode[] = []) =>
  ({ id, url: id, importedModules: new Set(imported) }) as unknown as EnvironmentModuleNode;

describe("routeStyles", () => {
  it("CSS の URL の、URL に使用できない文字をパーセントエンコードする", () => {
    expect(routeStyles([node("/src/page.tsx", [node("/src/a b#c.css")])])).toEqual([
      "/src/a%20b%23c.css?direct",
    ]);
  });
});
