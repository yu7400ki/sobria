import { describe, expect, it } from "vitest";

import { href } from "../../src/shared/router.ts";

/** `RouteParams` を拡張していないテストから、任意のルートで `href` を呼ぶ。 */
const anyHref = href as (route: string, params?: object, query?: object) => string;

describe("href", () => {
  it("動的な区切りを URL エンコードしたパラメータの値に置き換え、数も受け付ける", () => {
    expect(anyHref("/users/[id]", { id: 3 })).toBe("/users/3");
    expect(anyHref("/users/[id]/posts/[post]", { id: "a b", post: "x/y?" })).toBe(
      "/users/a%20b/posts/x%2Fy%3F",
    );
  });

  it("キャッチオールの値は、/ を区切りとして残し、区切りごとにエンコードする", () => {
    expect(anyHref("/docs/[...slug]", { slug: "a/b c/d" })).toBe("/docs/a/b%20c/d");
  });

  it("クエリをオブジェクトか URLSearchParams で受け取り、空なら ? を付けない", () => {
    expect(anyHref("/users", undefined, { page: 2, q: "a&b" })).toBe("/users?page=2&q=a%26b");
    expect(anyHref("/users", undefined, new URLSearchParams([["tag", "x"]]))).toBe("/users?tag=x");
    expect(anyHref("/users", undefined, {})).toBe("/users");
    expect(anyHref("/")).toBe("/");
  });
});
