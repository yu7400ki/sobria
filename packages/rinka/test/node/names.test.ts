import { describe, expect, it } from "vitest";

import { propToAttribute, tagFromPath } from "../../src/shared/names.ts";

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

  it("Custom Element の名前にならないファイル名は、パスとタグ名を示すエラーにする", () => {
    expect(() => tagFromPath("app", "カード.tsx")).toThrow(
      "src/elements/カード.tsx のタグ名 app-カード は、Custom Element の名前にできません。",
    );
    expect(() => tagFromPath("app", "user card.tsx")).toThrow("user card.tsx");
  });
});
