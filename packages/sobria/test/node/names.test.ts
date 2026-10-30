import { describe, expect, expectTypeOf, it } from "vitest";

import {
  customEventName,
  isAriaOrDataProp,
  isEventProp,
  listenerEventName,
  propToAttribute,
  reservedProp,
  tagFromPath,
  type AriaOrDataPropName,
  type EventPropName,
} from "../../src/shared/names.ts";

describe("propToAttribute", () => {
  it("props の名前を kebab-case にし、大文字の連続を 1 語として扱う", () => {
    expect(propToAttribute("userId")).toBe("user-id");
    expect(propToAttribute("imageURL")).toBe("image-url");
    expect(propToAttribute("HTMLViewer")).toBe("html-viewer");
    expect(propToAttribute("heading")).toBe("heading");
  });
});

describe("tagFromPath", () => {
  it("プレフィックスと要素のディレクトリからのパスを - で連結する", () => {
    expect(tagFromPath("app", "user-card.tsx")).toBe("app-user-card");
    expect(tagFromPath("app", "forms/DatePicker.tsx")).toBe("app-forms-date-picker");
    expect(tagFromPath("app", "forms/index.tsx")).toBe("app-forms");
    expect(tagFromPath("app", "HTMLViewer.tsx")).toBe("app-html-viewer");
    expect(tagFromPath("app", "snake_case_name.ts")).toBe("app-snake-case-name");
    expect(tagFromPath("x", "card.jsx")).toBe("x-card");
  });

  it("Custom Element の名前にできないファイル名では、パスとタグ名を示すエラーを投げる", () => {
    expect(() => tagFromPath("app", "カード.tsx")).toThrow(
      "タグ名 app-カード（要素のファイル カード.tsx）は、Custom Element の名前にできません。",
    );
    expect(() => tagFromPath("app", "user card.tsx")).toThrow("user card.tsx");
  });
});

describe("特別な props の名前", () => {
  it("ref、key、load: で始まる名前を予約された props とし、種類を返す", () => {
    expect(["ref", "key", "load:visible", "load:idle"].map(reservedProp)).toEqual([
      "ref",
      "key",
      "load:",
      "load:",
    ]);
    for (const name of ["children", "onClick", "loading", "Ref"])
      expect(reservedProp(name)).toBeUndefined();
  });

  it("on と大文字で始まる名前をイベントの props とし、発行するイベント名を kebab-case に、リスナーのイベント名を小文字にする", () => {
    for (const name of ["onClick", "onLikeClick", "onSale"]) expect(isEventProp(name)).toBe(true);
    for (const name of ["on", "online", "onclick", "click"]) expect(isEventProp(name)).toBe(false);
    expect(customEventName("onSelect")).toBe("select");
    expect(customEventName("onLikeClick")).toBe("like-click");
    expect(listenerEventName("onClick")).toBe("click");
    expect(listenerEventName("onDblClick")).toBe("dblclick");
  });

  it("要素のディレクトリの直下の index のファイルはエラーにする", () => {
    expect(() => tagFromPath("app", "index.tsx")).toThrow("要素のファイル index.tsx");
  });
});

describe("名前の規則の実行時の判定と型", () => {
  const names = [
    "onClick",
    "on",
    "on1",
    "on_x",
    "once",
    "ariaLabel",
    "aria1",
    "ariaÉ",
    "dataId",
    "database",
  ] as const;
  type Name = (typeof names)[number];

  it("isEventProp と EventPropName は、on と英字の大文字で始まる名前だけを選ぶ", () => {
    expect(names.filter((name) => isEventProp(name))).toEqual(["onClick"]);
    expectTypeOf<Extract<Name, EventPropName>>().toEqualTypeOf<"onClick">();
  });

  it("isAriaOrDataProp と AriaOrDataPropName は、aria か data と英字の大文字で始まる名前だけを選ぶ", () => {
    expect(names.filter((name) => isAriaOrDataProp(name))).toEqual(["ariaLabel", "dataId"]);
    expectTypeOf<Extract<Name, AriaOrDataPropName>>().toEqualTypeOf<"ariaLabel" | "dataId">();
  });
});
