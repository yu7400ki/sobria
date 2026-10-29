import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { settingsOf } from "../../src/build/settings.ts";

/** 設定を求めるアプリのルートである。 */
const root = fileURLToPath(new URL(".", import.meta.url));

describe("Vite の base", () => {
  it("アプリでは、末尾に / を補った値にする", () => {
    expect(settingsOf(root, "/sub", "build", {}, []).base).toBe("/sub/");
    expect(settingsOf(root, undefined, "serve", {}, []).base).toBe("/");
  });

  it.each(["./", "", "sub/", "//cdn.example/", "https://cdn.example/"])(
    "アプリでは、/ で始まらないか // で始まる %j をエラーにする",
    (value) => {
      expect(() => settingsOf(root, value, "build", {}, [])).toThrow(/Vite の base/);
    },
  );

  it("ライブラリでは、指定した値に関わらず / にする", () => {
    expect(settingsOf(root, "./", "build", { library: true }, []).base).toBe("/");
  });
});
