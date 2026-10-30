import { describe, expect, it } from "vitest";

import { attributeValue, tagAttributeName } from "../../src/shared/attributes.ts";

describe("attributeValue", () => {
  it("true は値の無い属性に、false、null、undefined は出力しない値にする", () => {
    expect(attributeValue("disabled", true)).toBe("");
    expect(attributeValue("disabled", false)).toBeNull();
    expect(attributeValue("title", null)).toBeNull();
    expect(attributeValue("title", undefined)).toBeNull();
  });

  it("aria-* と列挙型の属性の真偽値は、true と false のどちらも文字列にする", () => {
    for (const name of ["aria-checked", "draggable", "spellcheck", "contenteditable"]) {
      expect(attributeValue(name, true)).toBe("true");
      expect(attributeValue(name, false)).toBe("false");
    }
    expect(attributeValue("aria-label", null)).toBeNull();
    expect(attributeValue("ariaHidden", true)).toBe("");
  });

  it("空の文字列は空の値の属性にし、数値とオブジェクトは文字列にする", () => {
    expect(attributeValue("alt", "")).toBe("");
    expect(attributeValue("width", 10)).toBe("10");
    expect(attributeValue("href", new URL("https://example.com/a"))).toBe("https://example.com/a");
  });

  it("class のオブジェクトは、値が真のキーを空白で区切り、真のキーが無ければ出力しない", () => {
    expect(attributeValue("class", { a: true, b: false, c: 1, d: "" })).toBe("a c");
    expect(attributeValue("class", { a: false })).toBeNull();
    expect(attributeValue("class", "x y")).toBe("x y");
    expect(attributeValue("class", ["a", "b"])).toBe("a,b");
  });
});

describe("tagAttributeName", () => {
  it("key は data-ok にし、ほかの名前はそのまま返す", () => {
    expect(tagAttributeName("key")).toBe("data-ok");
    expect(tagAttributeName("class")).toBe("class");
    expect(tagAttributeName("aria-label")).toBe("aria-label");
  });
});
