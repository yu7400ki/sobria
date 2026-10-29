import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { settingsOf } from "../../src/build/settings.ts";

/** 設定を求めるアプリのルートである。 */
const root = fileURLToPath(new URL(".", import.meta.url));

describe("Vite の base", () => {
  it("アプリでは、. と .. の区切りを解決し、URL の符号化をして、末尾に / を補った値にする", () => {
    expect(settingsOf(root, "/sub", "build", {}, []).base).toBe("/sub/");
    expect(settingsOf(root, "/my app", "build", {}, []).base).toBe("/my%20app/");
    expect(settingsOf(root, "/a/../sub/./x", "build", {}, []).base).toBe("/sub/x/");
    expect(settingsOf(root, undefined, "serve", {}, []).base).toBe("/");
  });

  it.each([
    "./",
    "",
    "sub/",
    "//cdn.example/",
    "https://cdn.example/",
    "/50%",
    "/50%25",
    "/a\\b",
    "/\t/foo",
  ])("アプリでは、パスとして扱えない %j をエラーにする", (value) => {
    expect(() => settingsOf(root, value, "build", {}, [])).toThrow(/Vite の base/);
  });

  it("ライブラリでは、指定した値に関わらず / にする", () => {
    expect(settingsOf(root, "./", "build", { library: true }, []).base).toBe("/");
  });
});
