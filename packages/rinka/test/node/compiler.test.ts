import { describe, expect, it } from "vitest";

import { CompileError, transformSource } from "../../src/build/compiler.ts";
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

/** 要素のファイル `src/elements/x.tsx`（タグ名 `app-x`）として `code` を変換する。 */
function element(code: string) {
  return transformSource(code, {
    file: "src/elements/x.tsx",
    lang: "tsx",
    client: false,
    element: { tag: "app-x" },
  });
}

/** 要素のファイルとして `code` を変換し、受け付ける props の名前の一覧を返す。 */
const props = (code: string) => element(code).element?.options.props;

/** 要素のファイルとして `code` を変換する関数を返す。 */
const fails = (code: string) => () => element(code);

describe("Props の型の解析", () => {
  it("Props の各メンバーを、型の記述から分類する", () => {
    const { element: info } = element(`import type { Slot } from "rinka";
type Props = {
  userId: number;
  compact?: boolean;
  label: string;
  data?: { a: 1 };
  onSelect?: (user: string) => void;
  open(): void;
  header?: JSX.Element;
  footer?: Slot;
  children?: JSX.Element;
  mode?: "a" | "b";
  size?: 1 | 2 | undefined | null;
  mixed?: string | number;
  handler?: Handler;
};
export default function X(props: Props) { return <p />; }`);
    expect(info?.options).toEqual({
      props: [
        "userId",
        "compact",
        "label",
        "data",
        "onSelect",
        "open",
        "mode",
        "size",
        "mixed",
        "handler",
      ],
      types: {
        userId: "number",
        compact: "boolean",
        label: "string",
        mode: "string",
        size: "number",
      },
      slots: ["header", "footer"],
      functionProps: ["onSelect", "open"],
    });
  });

  it("interface と、引数の型リテラルと、rinka の Props<T> で包んだ型を解析する", () => {
    expect(
      props(`export interface Props { a: string }
export default function X(props: Props) { return <p />; }`),
    ).toEqual(["a"]);
    expect(props(`export default function X(props: { b: number }) { return <p />; }`)).toEqual([
      "b",
    ]);
    expect(
      props(`import type { Props as P } from "rinka";
type CardProps = P<{ c: boolean }>;
export default function X(props: CardProps) { return <p />; }`),
    ).toEqual(["c"]);
    expect(props(`export default function X() { return <p />; }`)).toEqual([]);
  });

  it("解析できない型と、props にできない名前は、ビルドのエラーにする", () => {
    const end = "export default function X(props: Props) { return <p />; }";
    expect(fails(`import type { Props } from "./props.ts";\n${end}`)).toThrow(CompileError);
    expect(fails(`type A = { a: string }; type Props = A & { b: number };\n${end}`)).toThrow(
      /Props/,
    );
    expect(
      fails(
        `import type { Props as P } from "rinka"; type Base = { a: string }; type Props = P<Base>;\n${end}`,
      ),
    ).toThrow(/型リテラル/);
    expect(fails(`export default function X({ a }: { a: string }) { return <p />; }`)).toThrow(
      /分割代入/,
    );
    expect(fails(`type Props = { ref: string };\n${end}`)).toThrow(/"ref"/);
    expect(fails(`type Props = { title: string };\n${end}`)).toThrow(/"title"/);
  });
});

describe("要素の登録", () => {
  it("default export した関数を、タグ名と Props の解析の結果を渡して要素を登録する呼び出しにする", () => {
    const { code } = element(`type Props = { a: string; onPick?: () => void };
export default function X(props: Props) { return <p />; }`);
    expect(code).toContain('import { defineElement as __rinka_defineElement } from "rinka";');
    expect(code).toContain("function X(props: Props) { return <p />; }");
    expect(code).not.toContain("export default function");
    expect(code).toContain(
      'export default __rinka_defineElement("app-x", X, {"props":["a","onPick"],"types":{"a":"string"},"functionProps":["onPick"]});',
    );
  });

  it("関数の宣言を default export していない要素のファイルは、ビルドのエラーにする", () => {
    expect(() => element("export default (props: {}) => <p />;")).toThrow(
      /export default function/,
    );
    expect(() => element("export default function (props: {}) { return <p />; }")).toThrow(
      /export default function/,
    );
    expect(() => element("export const x = 1;")).toThrow(/export default function/);
  });
});
