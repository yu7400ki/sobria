import type { ConfigEnv, Plugin } from "vite";
import { describe, expect, it } from "vitest";

import { sobria } from "../../src/build/plugin.ts";

/** `sobria()` が返すプラグインのうち、`command` と `library` の組で適用されるものを返す。 */
function applied(command: ConfigEnv["command"], library: boolean): Plugin[] {
  const env: ConfigEnv = { command, mode: "production" };
  return sobria(library ? { library: true } : {}).filter(({ apply }) =>
    apply === undefined ? true : typeof apply === "string" ? apply === command : apply({}, env),
  );
}

/** `command` と `library` の組で適用されるプラグインの名前を返す。 */
const names = (command: ConfigEnv["command"], library: boolean): string[] =>
  applied(command, library).map((plugin) => plugin.name);

describe("場面ごとのプラグイン", () => {
  it("command と library の組ごとに、場面のプラグインを 1 つだけ適用する", () => {
    expect({
      serve: names("serve", false),
      serveLibrary: names("serve", true),
      build: names("build", false),
      buildLibrary: names("build", true),
    }).toEqual({
      serve: ["sobria", "sobria:extensions", "sobria:oxc", "sobria:jsx", "sobria:serve"],
      serveLibrary: ["sobria", "sobria:extensions", "sobria:oxc", "sobria:jsx", "sobria:serve"],
      build: ["sobria", "sobria:extensions", "sobria:oxc", "sobria:jsx", "sobria:build"],
      buildLibrary: ["sobria", "sobria:extensions", "sobria:oxc", "sobria:jsx", "sobria:library"],
    });
  });

  it("ビルドで適用するプラグインは、すべて sharedDuringBuild を指定する", () => {
    const unshared = [false, true].flatMap((library) =>
      applied("build", library)
        .filter((plugin) => plugin.sharedDuringBuild !== true)
        .map((plugin) => plugin.name),
    );
    expect(unshared).toEqual([]);
  });
});

/** `sobria` のプラグインの resolveId で、`consumer` の環境から `id` を解決した値を返す。 */
function resolve(id: string, consumer: "client" | "server"): unknown {
  const plugin = sobria().find(({ name }) => name === "sobria");
  const hook = plugin?.resolveId;
  const handler = typeof hook === "function" ? hook : hook?.handler;
  const context = { environment: { config: { consumer } } } as never;
  return handler?.call(context, id, undefined, { isEntry: false, attributes: {} } as never);
}

describe("実行時のコードの入口の解決", () => {
  it("sobria の入口を環境ごとのファイルに解決し、Object のプロトタイプにある名前は解決しない", () => {
    expect(resolve("sobria", "client")).toMatch(/[\\/]client[\\/]index\.js$/);
    expect(resolve("sobria", "server")).toMatch(/[\\/]server[\\/]index\.js$/);
    for (const consumer of ["client", "server"] as const) {
      expect(resolve("constructor", consumer)).toBeNull();
      expect(resolve("__proto__", consumer)).toBeNull();
    }
  });
});
