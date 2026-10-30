import { describe, expect, it } from "vitest";

import { formDataToInput } from "../../src/server/form-data.ts";

/** `entries` の名前と値を、順に追加した FormData を返す。 */
function form(entries: [string, string | File][]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}

describe("FormData の名前の構造", () => {
  it(". はオブジェクトに、[数] はオブジェクトの配列に、[] はフィールドごとに要素を追加する配列にする", () => {
    expect(
      formDataToInput(
        form([
          ["title", "a"],
          ["address.city", "Tokyo"],
          ["address.zip", "100"],
          ["items[0].name", "x"],
          ["items[0].count", "1"],
          ["items[1].name", "y"],
          ["tags[]", "t1"],
          ["tags[]", "t2"],
        ]),
      ),
    ).toEqual({
      title: "a",
      address: { city: "Tokyo", zip: "100" },
      items: [{ name: "x", count: "1" }, { name: "y" }],
      tags: ["t1", "t2"],
    });
  });

  it("同じ名前を繰り返すと配列にする", () => {
    expect(
      formDataToInput(
        form([
          ["c", "1"],
          ["c", "2"],
          ["c", "3"],
        ]),
      ),
    ).toEqual({ c: ["1", "2", "3"] });
  });

  it("ファイルは File のまま渡す", () => {
    const file = new File(["body"], "a.txt");
    const input = formDataToInput(form([["upload", file]])) as { upload: unknown };
    expect(input.upload).toBeInstanceOf(File);
    expect((input.upload as File).name).toBe("a.txt");
  });

  it("名前の区切りに __proto__、constructor、prototype を含むフィールドは捨てる", () => {
    const input = formDataToInput(
      form([
        ["__proto__.polluted", "1"],
        ["a.constructor.prototype.polluted", "1"],
        ["b.prototype", "1"],
        ["ok", "1"],
      ]),
    );
    expect(input).toEqual({ ok: "1" });
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("同じ名前を、配列でない形と配列の形の両方で使用すると、後に出現した形の値を捨てる", () => {
    expect(
      formDataToInput(
        form([
          ["tags", "x"],
          ["tags[]", "y"],
        ]),
      ),
    ).toEqual({ tags: "x" });
    expect(
      formDataToInput(
        form([
          ["tags[]", "y"],
          ["tags", "x"],
        ]),
      ),
    ).toEqual({ tags: ["y"] });
    expect(
      formDataToInput(
        form([
          ["a.b", "1"],
          ["a", "2"],
        ]),
      ),
    ).toEqual({ a: { b: "1" } });
  });

  it("配列の添字が、それまでの要素の数より大きいフィールドは捨てる", () => {
    expect(
      formDataToInput(
        form([
          ["items[0]", "a"],
          ["items[5]", "b"],
        ]),
      ),
    ).toEqual({ items: ["a"] });
  });
});
