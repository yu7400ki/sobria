import { describe, expect, it } from "vitest";

import { checkExposeName } from "../../src/shared/expose-names.ts";

describe("checkExposeName", () => {
  it("HTMLElement のメンバーの上書きを許す", () => {
    for (const name of ["focus", "blur", "click", "value", "open", "contains", "querySelector"]) {
      expect(checkExposeName(name, [])).toBeUndefined();
    }
  });

  it("構造、属性、イベント、Shadow DOM、ElementInternals を操作するメンバーを拒否する", () => {
    for (const name of [
      "remove",
      "append",
      "insertBefore",
      "insertAdjacentHTML",
      "setHTMLUnsafe",
      "setAttribute",
      "addEventListener",
      "dispatchEvent",
      "attachShadow",
      "shadowRoot",
      "attachInternals",
    ]) {
      expect(checkExposeName(name, [])).toContain(`"${name}" は expose で公開できません。`);
    }
  });

  it("ライフサイクルのコールバック、フォームの部品の API、props の名前を拒否する", () => {
    for (const name of ["connectedCallback", "form", "validity"]) {
      expect(checkExposeName(name, [])).toContain(`"${name}" は expose で公開できません。`);
    }
    expect(checkExposeName("heading", ["heading"])).toContain("props");
  });
});
