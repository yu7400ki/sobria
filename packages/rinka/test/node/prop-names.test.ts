import { describe, expect, expectTypeOf, it } from "vitest";

import {
  checkPropNames,
  type HostAttribute,
  type PropNameError,
} from "../../src/shared/prop-names.ts";

describe("checkPropNames", () => {
  it("問題の無い名前では、空の配列を返す", () => {
    expect(
      checkPropNames(["heading", "userId", "onSelect", "children", "header", "items"]),
    ).toEqual([]);
  });

  it("ホストの属性とグローバル属性は、名前、理由、代わりの名前の例を示す", () => {
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

  it("予約された props は、代わりの名前の例を示す", () => {
    const [ref, key, load] = checkPropNames(["ref", "key", "load:visible"]);
    expect(ref).toContain("のような名前を使用してください。");
    expect(key).toContain("のような名前を使用してください。");
    expect(load).toContain("のような名前を使用してください。");
  });

  it("HTMLElement と Object のメンバー、ライフサイクルのコールバック、フォームの部品の API は、大文字と小文字を区別して照合する", () => {
    for (const name of [
      "remove",
      "focus",
      "textContent",
      "onclick",
      "toString",
      "constructor",
      "hasOwnProperty",
      "__proto__",
      "connectedCallback",
      "attributeChangedCallback",
      "form",
      "labels",
      "checkValidity",
    ]) {
      expect(checkPropNames([name])[0]).toContain(`"${name}" は props の名前にできません。`);
    }
    expect(checkPropNames(["onClick", "Remove", "ToString"])).toEqual([]);
  });

  it("名前ごとの例が無い名前は、要素の役割を表す別の名前を促す", () => {
    expect(checkPropNames(["connectedCallback"])[0]).toContain(
      "要素の役割を表す別の名前を使用してください。",
    );
  });

  it("同じ属性名になる props の組を示す", () => {
    expect(checkPropNames(["userId", "userID"])).toEqual([
      '"userId" と "userID" は、どちらも属性名 user-id になります。どちらかの名前を変更してください。',
    ]);
  });
});

describe("HostAttribute", () => {
  it("ホストで意味を持つ属性の名前だけを表す", () => {
    expectTypeOf<"id" | "tabindex" | "inputmode">().toExtend<HostAttribute>();
    expectTypeOf<"label">().not.toExtend<HostAttribute>();
  });
});

describe("PropNameError", () => {
  it("判定の経路ごとに、ビルドのエラーと同じ文を表す", () => {
    const cases = [
      [
        "ref",
        '"ref" は props の名前にできません。rinka が要素への ref として扱うためです。内側のノードを受け取る関数には inputRef のような名前を使用してください。' satisfies PropNameError<"ref">,
      ],
      [
        "load:idle",
        '"load:idle" は props の名前にできません。rinka が要素を読み込むタイミングの指定として扱うためです。読み込みの状態には loadState のような名前を使用してください。' satisfies PropNameError<"load:idle">,
      ],
      [
        "ariaLabel",
        '"ariaLabel" は props の名前にできません。rinka が aria-* と data-* の属性を、そのままホストに渡すためです。代わりに label のような名前を使用してください。' satisfies PropNameError<"ariaLabel">,
      ],
      [
        "title",
        '"title" は props の名前にできません。要素の全体にツールチップが表示されるためです。見出しには heading のような名前を使用してください。' satisfies PropNameError<"title">,
      ],
      [
        "focus",
        '"focus" は props の名前にできません。props はホストのプロパティになり、ホストの focus を上書きするためです。要素の役割を表す別の名前を使用してください。' satisfies PropNameError<"focus">,
      ],
      [
        "validity",
        '"validity" は props の名前にできません。rinka がフォームの部品のホストに validity を付与するためです。要素の役割を表す別の名前を使用してください。' satisfies PropNameError<"validity">,
      ],
      [
        "connectedCallback",
        '"connectedCallback" は props の名前にできません。Custom Element のライフサイクルのコールバックと衝突するためです。要素の役割を表す別の名前を使用してください。' satisfies PropNameError<"connectedCallback">,
      ],
    ] as const;
    for (const [name, message] of cases) expect(checkPropNames([name])).toEqual([message]);
  });
});
