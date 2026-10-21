import { fromJSON, toJSON } from "seroval";
import { describe, expect, it } from "vitest";

import { fromRpcInput, toRpcBody, toScript } from "../../src/server/wire.ts";
import { checkSerializable, isJson } from "../../src/shared/wire.ts";

/** toScript が出力した JS の式を評価する。 */
// oxlint-disable-next-line typescript/no-implied-eval
const run = (script: string): unknown => new Function(`return ${script}`)();

describe("isJson", () => {
  it("JSON.stringify で変化しない値だけを JSON とする", () => {
    expect(isJson({ a: [1, "x", null, true], b: { c: 1.5 } })).toBe(true);
    const sparse: unknown[] = [];
    sparse[1] = 1;
    const values: unknown[] = [
      new Date(0),
      new Map(),
      1n,
      undefined,
      { a: undefined },
      sparse,
      Number.NaN,
      -0,
    ];
    for (const value of values) expect(isJson(value)).toBe(false);
    expect(isJson(Object.create({}))).toBe(false);
    expect(isJson(Object.assign(Object.create(null) as object, { a: 1 }))).toBe(true);
  });
});

describe("checkSerializable", () => {
  it("送れない値の位置を示す", () => {
    class Point {
      x = 1;
    }
    expect(() => checkSerializable({ a: [{ p: new Point() }] }, "props")).toThrow(
      "props.a[0].p は Point のインスタンスなので、シリアライズできません。",
    );
    expect(() => checkSerializable({ cb: () => 1 }, "props")).toThrow(
      "props.cb は関数なので、シリアライズできません。",
    );
    expect(() => checkSerializable({ s: Symbol("x") }, "v")).toThrow("v.s は symbol なので");
    expect(() => checkSerializable({ p: Promise.resolve(1) }, "v")).toThrow(
      "v.p は Promise なので、シリアライズできません。await してから渡してください。",
    );
    expect(() => checkSerializable({ e: new TypeError("x") }, "v")).toThrow(
      "v.e は Error なので、送信できません。",
    );
    expect(() => checkSerializable(new Map([["k", () => 1]]), "v")).toThrow(
      "v.get(k) は関数なので",
    );
    expect(() => checkSerializable(new Map([[Symbol("k"), 1]]), "v")).toThrow(
      "v のキー は symbol なので",
    );
  });

  it("seroval が扱える値と、循環する参照を受け付ける", () => {
    const value = {
      d: new Date(),
      m: new Map([[1, new Set([2n])]]),
      r: /x/g,
      u: new Uint8Array(2),
      n: Object.create(null) as object,
    };
    expect(() => checkSerializable(value, "v")).not.toThrow();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => checkSerializable(cyclic, "v")).not.toThrow();
  });
});

describe("toScript", () => {
  it("型と参照を保つ JS の式を返す", () => {
    const shared = { n: 1 };
    const value = {
      at: new Date(5),
      big: 10n,
      none: undefined,
      tags: new Map([["x", new Set([1, 2])]]),
      a: shared,
      b: shared,
      special: [Number.NaN, -0, Infinity],
      re: /a+/gi,
      bytes: new Uint8Array([1, 2]),
    };
    const result = run(toScript(value, "v")) as typeof value;
    expect(result).toEqual(value);
    expect("none" in result).toBe(true);
    expect(result.a).toBe(result.b);
    expect(Object.is(result.special[1], -0)).toBe(true);
  });

  it("出力は < を含まないので、埋め込んだ値が script 要素を閉じない", () => {
    expect(toScript({ html: "</script><script>alert(1)</script>" }, "v")).not.toContain("<");
  });

  it("Error は seroval が出力できても拒否し、位置を示す", () => {
    expect(() => toScript({ a: [new TypeError("x")] }, "v")).toThrow(
      "v.a[0] は Error なので、送信できません。",
    );
  });

  it("クラスのインスタンスは位置を示すエラーにする", () => {
    class User {
      name = "a";
    }
    expect(() => toScript({ user: new User() }, "<app-card>")).toThrow(
      "<app-card>.user は User のインスタンスなので、シリアライズできません。",
    );
  });
});

describe("RPC の値", () => {
  it("JSON で表せる値は { ok } に、表せない値は seroval の JSON の形式の { s } にする", () => {
    expect(toRpcBody({ a: 1 })).toEqual({ ok: { a: 1 } });
    const body = toRpcBody({ at: new Date(3) });
    expect("s" in body).toBe(true);
    if ("s" in body) expect(fromJSON(body.s)).toEqual({ at: new Date(3) });
  });

  it("戻り値の Error は位置を示すエラーにする", () => {
    expect(() => toRpcBody({ e: new Error("x") })).toThrow(
      "サーバー関数の戻り値.e は Error なので、送信できません。",
    );
  });

  it("seroval の JSON の形式の入力を読む", () => {
    expect(fromRpcInput(toJSON({ from: new Date(10), seen: new Set([1]) }))).toEqual({
      from: new Date(10),
      seen: new Set([1]),
    });
  });
});
