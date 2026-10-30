import { describe, expect, it } from "vitest";

import { cookieAfter } from "../../src/server/cookies.ts";

/** `cookieAfter` に渡す現在の時刻である。 */
const now = Date.parse("2026-10-24T00:00:00Z");

describe("cookieAfter", () => {
  it("Set-Cookie の値で同じ名前の Cookie を上書きし、新しい名前の Cookie を後ろに追加する", () => {
    expect(cookieAfter("a=1; b=2", ["a=3; Path=/; HttpOnly", "c=4"], now)).toBe("a=3; b=2; c=4");
  });

  it("Max-Age が 0 以下の Set-Cookie と、Max-Age が無く Expires が過去の Set-Cookie の名前を取り除く", () => {
    expect(
      cookieAfter(
        "a=1; b=2; c=3; d=4",
        [
          "a=; Max-Age=0",
          "b=; Max-Age=-1",
          "c=; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
          "d=5; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        ],
        now,
      ),
    ).toBe("d=5");
  });

  it("Cookie のヘッダーに同じ名前が複数あれば、最初の値を使用する", () => {
    expect(cookieAfter("sid=specific; sid=root", [], now)).toBe("sid=specific");
  });

  it("Cookie のヘッダーが無ければ、Set-Cookie の値だけを返す", () => {
    expect(cookieAfter(undefined, ["flash=1; Path=/"], now)).toBe("flash=1");
    expect(cookieAfter(undefined, [], now)).toBe("");
  });
});
