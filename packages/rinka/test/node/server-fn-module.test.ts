import { describe, expect, it } from "vitest";

import { hashedFnModule } from "../../src/build/server-fns.ts";

describe("サーバー関数の ID のモジュールの部分", () => {
  it("ファイルのパスの SHA-256 を base64url にした値の先頭 10 文字に、m を付ける", () => {
    expect(hashedFnModule("src/lib/a.ts")).toBe("mMZVHZM5VRS");
    expect(hashedFnModule("src/lib/b.ts")).not.toBe(hashedFnModule("src/lib/a.ts"));
  });
});
