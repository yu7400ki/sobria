import { describe, expect, it } from "vitest";

import { transformSource } from "../../src/build/compiler.ts";
import { takeGate } from "../../src/client/internal.ts";
import { runSeeding } from "../../src/shared/scope.ts";

/** `.ts` のモジュール `src/lib/a.ts` として `code` を変換し、空白をまとめたコードを返す。 */
function module(code: string, client = false): string {
  return transformSource(code, { file: "src/lib/a.ts", lang: "ts", client }).code.replaceAll(
    /\s+/g,
    " ",
  );
}

describe("memo の呼び出し箇所の ID", () => {
  it("rinka から import した memo の呼び出しに、ファイルと行と列の ID を付与する", () => {
    const code = module(`import { memo as m } from "rinka";
const a = m(() => 1);
const b = m(() => 2, { equals: false });
const c = m(() => 3, options);
const d = m(() => 4, {});`);
    expect(code).toContain('m(() => 1, { site: "src/lib/a.ts:2:11" })');
    expect(code).toContain('m(() => 2, { site: "src/lib/a.ts:3:11", equals: false })');
    expect(code).toContain('m(() => 3, { ...options, site: "src/lib/a.ts:4:11" })');
    expect(code).toContain('m(() => 4, { site: "src/lib/a.ts:5:11" })');
  });

  it("rinka 以外から import した memo と、自分で定義した memo には付与しない", () => {
    const code = module(`import { memo as other } from "./memo.ts";
const memo = (fn: () => number) => fn;
other(() => 1);
memo(() => 2);`);
    expect(code).not.toContain("site");
  });
});

describe("await の関門", () => {
  const source = `export async function load(id: number) {
  const token = await read();
  const inner = async () => await other();
  return get(id, await token.id);
}
export const arrow = async () => await x();
export function* generate() { yield 1; }
export async function* stream() { await y(); }
export async function none() { return 1; }`;

  it("クライアント向けのコードでは、async 関数の直接の await を、その関数の関門で包む", () => {
    const code = module(source, true);
    expect(code).toContain('import { takeGate as __rinka_takeGate } from "rinka/internal";');
    expect(code).toContain(
      "async function load(id: number) { const __rinka_gate = __rinka_takeGate(); const token = await __rinka_gate(read());",
    );
    expect(code).toContain(
      "const inner = async () => { const __rinka_gate = __rinka_takeGate(); return await __rinka_gate(other()); };",
    );
    expect(code).toContain("return get(id, await __rinka_gate(token.id));");
    expect(code).toContain(
      "export const arrow = async () => { const __rinka_gate = __rinka_takeGate(); return await __rinka_gate(x()); };",
    );
    expect(code).toContain("export async function* stream() { await y(); }");
    expect(code).toContain("export async function none() { return 1; }");
  });

  it("サーバー向けのコードと、async 関数の無いコードは関門で包まない", () => {
    expect(module(source)).not.toContain("__rinka");
    expect(module("export const x = 1;", true)).toBe("export const x = 1;");
  });

  it("関門は、シード中に取得したら解決しない Promise を返し、それ以外では値をそのまま返す", async () => {
    const value = Promise.resolve(1);
    expect(takeGate()(value)).toBe(value);
    const seeded = runSeeding(() => takeGate())(value);
    const settled = await Promise.race([seeded.then(() => "settled"), Promise.resolve("pending")]);
    expect(settled).toBe("pending");
  });
});
