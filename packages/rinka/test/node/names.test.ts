import { describe, expect, it } from "vitest";

import {
  eventName,
  isEventProp,
  propToAttribute,
  reservedProp,
  tagFromPath,
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
  it("プレフィックスと src/elements/ からのパスを - で連結する", () => {
    expect(tagFromPath("app", "user-card.tsx")).toBe("app-user-card");
    expect(tagFromPath("app", "forms/DatePicker.tsx")).toBe("app-forms-date-picker");
    expect(tagFromPath("app", "forms/index.tsx")).toBe("app-forms");
    expect(tagFromPath("app", "HTMLViewer.tsx")).toBe("app-html-viewer");
    expect(tagFromPath("app", "snake_case_name.ts")).toBe("app-snake-case-name");
    expect(tagFromPath("x", "card.jsx")).toBe("x-card");
  });

  it("Custom Element の名前にできないファイル名では、パスとタグ名を示すエラーを投げる", () => {
    expect(() => tagFromPath("app", "カード.tsx")).toThrow(
      "src/elements/カード.tsx のタグ名 app-カード は、Custom Element の名前にできません。",
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

  it("on と大文字で始まる名前をイベントの props とし、イベント名を kebab-case にする", () => {
    for (const name of ["onClick", "onLikeClick", "onSale"]) expect(isEventProp(name)).toBe(true);
    for (const name of ["on", "online", "onclick", "click"]) expect(isEventProp(name)).toBe(false);
    expect(eventName("onSelect")).toBe("select");
    expect(eventName("onLikeClick")).toBe("like-click");
  });

  it("src/elements/ の直下の index のファイルはエラーにする", () => {
    expect(() => tagFromPath("app", "index.tsx")).toThrow("src/elements/index.tsx");
  });
});
