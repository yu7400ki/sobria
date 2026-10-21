import { describe, expect, it } from "vitest";

import { attributeName, attributeValue } from "../../src/shared/attributes.ts";

describe("attributeValue", () => {
  it("true は値の無い属性に、false、null、undefined は出力しない値にする", () => {
    expect(attributeValue("disabled", true)).toBe("");
    expect(attributeValue("disabled", false)).toBeNull();
    expect(attributeValue("title", null)).toBeNull();
    expect(attributeValue("title", undefined)).toBeNull();
  });

  it("aria-* と列挙型の属性の真偽値は、false でも文字列にする", () => {
    for (const name of ["aria-checked", "draggable", "spellcheck", "contenteditable"]) {
      expect(attributeValue(name, true)).toBe("true");
      expect(attributeValue(name, false)).toBe("false");
    }
    expect(attributeValue("aria-label", null)).toBeNull();
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
  });
});

describe("attributeName", () => {
  it("key は data-ok にし、ほかの名前はそのまま返す", () => {
    expect(attributeName("key")).toBe("data-ok");
    expect(attributeName("class")).toBe("class");
    expect(attributeName("aria-label")).toBe("aria-label");
  });
});
