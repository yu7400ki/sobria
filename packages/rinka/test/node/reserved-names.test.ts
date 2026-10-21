import { describe, expect, it } from "vitest";

import { htmlElementMembers, structuralMembers } from "../../src/shared/dom-names.generated.ts";
import { checkExposeName, checkPropNames } from "../../src/shared/reserved-names.ts";

describe("生成した一覧", () => {
  it("HTMLElement の継承したメンバーを含む", () => {
    for (const name of [
      "remove",
      "focus",
      "children",
      "textContent",
      "onclick",
      "addEventListener",
    ]) {
      expect(htmlElementMembers).toContain(name);
    }
  });

  it("expose で禁止するメンバーは、構造、属性、イベント、Shadow DOM を操作するものに限る", () => {
    for (const name of [
      "remove",
      "append",
      "insertBefore",
      "insertAdjacentHTML",
      "setHTMLUnsafe",
      "setAttribute",
      "dispatchEvent",
      "attachShadow",
      "shadowRoot",
      "attachInternals",
    ]) {
      expect(structuralMembers).toContain(name);
    }
    for (const name of [
      "focus",
      "blur",
      "click",
      "textContent",
      "children",
      "contains",
      "querySelector",
      "cloneNode",
    ]) {
      expect(structuralMembers).not.toContain(name);
    }
  });
});

describe("checkPropNames", () => {
  it("問題の無い名前では、空の配列を返す", () => {
    expect(
      checkPropNames(["heading", "userId", "onSelect", "children", "header", "items"]),
    ).toEqual([]);
    expect(checkPropNames(["constructor", "__proto__", "toString", "hasOwnProperty"])).toEqual([]);
  });

  it("名前、理由、代わりの名前の例を示す", () => {
    expect(checkPropNames(["title"])).toEqual([
      '"title" は props の名前にできません。要素の全体にツールチップが表示されるためです。見出しには heading のような名前を使用してください。',
    ]);
  });

  it("ホストの属性とグローバル属性は、大文字と小文字を区別せずに照合する", () => {
    for (const name of [
      "id",
      "Class",
      "style",
      "slot",
      "part",
      "exportparts",
      "is",
      "role",
      "tabIndex",
      "accessKey",
      "inputMode",
    ]) {
      expect(checkPropNames([name])).toHaveLength(1);
    }
  });

  it("aria か data の直後に大文字が続く名前を拒否する", () => {
    expect(checkPropNames(["ariaLabel", "dataId"])).toHaveLength(2);
    expect(checkPropNames(["database", "ariadne"])).toEqual([]);
  });

  it("HTMLElement のメンバーとフォームの部品の API は、大文字と小文字を区別して照合する", () => {
    for (const name of [
      "remove",
      "focus",
      "textContent",
      "onclick",
      "form",
      "labels",
      "validity",
      "checkValidity",
    ]) {
      expect(checkPropNames([name])[0]).toContain(`"${name}" は props の名前にできません。`);
    }
    expect(checkPropNames(["onClick", "Remove"])).toEqual([]);
  });

  it("予約された props を拒否する", () => {
    expect(checkPropNames(["ref", "key", "load:visible"])).toHaveLength(3);
  });

  it("同じ属性名になる props の組を示す", () => {
    expect(checkPropNames(["userId", "userID"])).toEqual([
      '"userId" と "userID" は、どちらも属性名 user-id になります。どちらかの名前を変更してください。',
    ]);
  });
});

describe("checkExposeName", () => {
  it("HTMLElement のメンバーの上書きを許す", () => {
    for (const name of ["focus", "blur", "click", "value", "open"])
      expect(checkExposeName(name, [])).toBeUndefined();
  });

  it("構造を操作するメンバー、ライフサイクルのコールバック、フォームの部品の API、props の名前を拒否する", () => {
    for (const name of [
      "remove",
      "setAttribute",
      "addEventListener",
      "shadowRoot",
      "attachInternals",
      "connectedCallback",
      "form",
      "validity",
    ]) {
      expect(checkExposeName(name, [])).toContain(`"${name}" は expose で公開できません。`);
    }
    expect(checkExposeName("heading", ["heading"])).toContain("props");
  });
});
