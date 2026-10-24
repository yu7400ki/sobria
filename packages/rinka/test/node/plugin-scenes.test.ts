import type { ConfigEnv, Plugin } from "vite";
import { describe, expect, it } from "vitest";

import { rinka } from "../../src/build/plugin.ts";

/** `rinka()` が返すプラグインのうち、`command` と `library` の組で適用されるものを返す。 */
function applied(command: ConfigEnv["command"], library: boolean): Plugin[] {
  const env: ConfigEnv = { command, mode: "production" };
  return rinka(library ? { library: true } : {}).filter(({ apply }) =>
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
      serve: ["rinka", "rinka:extensions", "rinka:oxc", "rinka:jsx", "rinka:serve"],
      serveLibrary: ["rinka", "rinka:extensions", "rinka:oxc", "rinka:jsx", "rinka:serve"],
      build: ["rinka", "rinka:extensions", "rinka:oxc", "rinka:jsx", "rinka:build"],
      buildLibrary: ["rinka", "rinka:extensions", "rinka:oxc", "rinka:jsx", "rinka:library"],
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
