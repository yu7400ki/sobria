import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { transformWithOxc } from "vite";
import { describe, expect, it } from "vitest";

import { CompileError, transformSource, type SourceOptions } from "../../src/build/compiler.ts";
import { oxc } from "../../src/build/entries.ts";
import { transformJsx } from "../../src/build/jsx.ts";
import { stopIfSeeding } from "../../src/client/internal.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToString } from "../../src/server/render.ts";
import { defineServerFn, definitionOf } from "../../src/server/server-fn.ts";
import { runSeeding } from "../../src/shared/scope.ts";

/** `.ts` のモジュール `src/lib/a.ts` として `code` を変換し、空白をまとめたコードを返す。 */
function module(code: string, client = false): string {
  return transformSource(code, {
    id: "src/lib/a.ts",
    file: "src/lib/a.ts",
    lang: "ts",
    client,
  }).code.replaceAll(/\s+/g, " ");
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

  it("クライアント向けのコードでも、式の本体の async 関数に付与する ID は、stopIfSeeding を呼ぶ関数の外の memo の引数にする", () => {
    const code = module(
      `import { memo } from "rinka";
const a = memo(async () => get(await id()));`,
      true,
    );
    expect(code).toContain(
      'const a = memo(async () => { const __rinka_stop = __rinka_stopIfSeeding(); return get(await __rinka_stop(id())); }, { site: "src/lib/a.ts:2:11" });',
    );
  });

  it("引数にスプレッドを含む呼び出しには付与しない", () => {
    const code = module(`import { memo } from "rinka";
memo(fn, ...rest);
memo(...args);`);
    expect(code).not.toContain("site");
  });

  it("rinka 以外から import した memo と、自分で定義した memo には付与しない", () => {
    const code = module(`import { memo as other } from "./memo.ts";
const memo = (fn: () => number) => fn;
other(() => 1);
memo(() => 2);`);
    expect(code).not.toContain("site");
  });
});

describe("シード中の await の停止", () => {
  const source = `export async function load(id: number) {
  const token = await read();
  const inner = async () => await other();
  return get(id, await token.id);
}
export const arrow = async () => await x();
export function* generate() { yield 1; }
export async function* stream() { await y(); }
export async function none() { return 1; }
export async function each() { for await (const v of source()) use(v); }`;

  it("クライアント向けのコードでは、async 関数の直接の await を、その関数が開始した時点で受け取った stopIfSeeding の戻り値に渡す", () => {
    const code = module(source, true);
    expect(code).toContain(
      'import { stopIfSeeding as __rinka_stopIfSeeding } from "rinka/internal";',
    );
    expect(code).toContain(
      "async function load(id: number) { const __rinka_stop = __rinka_stopIfSeeding(); const token = await __rinka_stop(read());",
    );
    expect(code).toContain(
      "const inner = async () => { const __rinka_stop = __rinka_stopIfSeeding(); return await __rinka_stop(other()); };",
    );
    expect(code).toContain("return get(id, await __rinka_stop(token.id));");
    expect(code).toContain(
      "export const arrow = async () => { const __rinka_stop = __rinka_stopIfSeeding(); return await __rinka_stop(x()); };",
    );
    expect(code).toContain("export async function* stream() { await y(); }");
    expect(code).toContain("export async function none() { return 1; }");
    expect(code).toContain(
      "export async function each() { const __rinka_stop = __rinka_stopIfSeeding(); for await (const v of __rinka_stop.iterate(source())) use(v); }",
    );
  });

  it("サーバー向けのコードと、async 関数の無いコードでは stopIfSeeding を呼ばない", () => {
    expect(module(source)).not.toContain("__rinka");
    expect(module("export const x = 1;", true)).toBe("export const x = 1;");
  });

  it("stopIfSeeding は、シード中に呼び出したら解決しない Promise と、最初の値を返さない async iterable を返し、それ以外では値をそのまま返す", async () => {
    const value = Promise.resolve(1);
    expect(stopIfSeeding()(value)).toBe(value);
    const seeded = runSeeding(() => stopIfSeeding())(value);
    const later = new Promise((done) => setTimeout(() => done("pending"), 10));
    expect(await Promise.race([seeded.then(() => "settled"), later])).toBe("pending");
    const items = [1];
    expect(stopIfSeeding().iterate(items)).toBe(items);
    const iterator = runSeeding(() => stopIfSeeding()).iterate(items);
    const first = (iterator as AsyncIterable<never>)[Symbol.asyncIterator]().next();
    const waited = new Promise((done) => setTimeout(() => done("pending"), 10));
    expect(await Promise.race([first.then(() => "settled"), waited])).toBe("pending");
  });
});

/** 要素のファイル `src/elements/x.tsx`（タグ名 `app-x`）として `code` を変換する。 */
function element(code: string) {
  return transformSource(code, {
    id: "src/elements/x.tsx",
    file: "src/elements/x.tsx",
    lang: "tsx",
    client: false,
    element: { tag: "app-x", module: "/src/elements/x.tsx" },
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
        "header",
        "footer",
        "children",
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
      objectProps: ["data"],
    });
  });

  it("負の数とテンプレートのリテラル型、getter、別名で import した Slot を分類する", () => {
    const { element: info } = element(`import type { Slot as S } from "rinka";
type Props = { n?: -1 | 1; t?: \`a\`; get g(): string; s?: S; o?: Slot };
export default function X(props: Props) { return <p />; }`);
    expect(info?.options).toEqual({
      props: ["n", "t", "g", "s", "o"],
      types: { n: "number", t: "string", g: "string" },
      slots: ["s"],
    });
  });

  it("型の記述と、同じファイルで宣言した type と interface から、オブジェクトと分かる props を objectProps に列挙する", () => {
    const { element: info } = element(`type Variant = "a" | "b";
type Handler = () => void;
type Loop = Loop[] | Loop;
interface User { name: string }
type Props = {
  list: string[];
  pair: readonly [number, string];
  map: { [key: string]: number };
  any: object;
  both: { a: 1 } | readonly string[];
  user: User;
  record: Record<string, number>;
  variant: Variant;
  handler: Handler;
  loop: Loop;
  imported: Imported;
  width: \`\${number}px\`;
  mixed: string | { a: 1 };
};
export default function X(props: Props) { return <p />; }`);
    expect(info?.options).toEqual({
      props: [
        "list",
        "pair",
        "map",
        "any",
        "both",
        "user",
        "record",
        "variant",
        "handler",
        "loop",
        "imported",
        "width",
        "mixed",
      ],
      types: { variant: "string" },
      functionProps: ["handler"],
      objectProps: ["list", "pair", "map", "any", "both", "user", "record"],
    });
  });

  it("同じ名前の interface の宣言を、1 つの Props の型にまとめる", () => {
    expect(
      props(`interface Props { a: string }
interface Props { b: number }
export default function X(props: Props) { return <p />; }`),
    ).toEqual(["a", "b"]);
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
    expect(fails(`export default function X(props) { return <p />; }`)).toThrow(/型注釈/);
    expect(fails(`type Props = { ref: string };\n${end}`)).toThrow(/"ref"/);
    expect(fails(`type Props = { title: string };\n${end}`)).toThrow(/"title"/);
  });
});

describe("要素の登録", () => {
  it("default export した関数を、タグ名と Props の解析の結果を渡して要素を登録する呼び出しにする", () => {
    const { code } = element(`type Props = { a: string; onPick?: () => void };
export default function X(props: Props) { return <p />; }`);
    expect(code).toContain(
      'import { defineElement as __rinka_defineElement } from "rinka/internal";',
    );
    expect(code).toContain("function X(props: Props) { return <p />; }");
    expect(code).not.toContain("export default function");
    expect(code).toContain(
      'export default __rinka_defineElement("app-x", X, {"props":["a","onPick"],"types":{"a":"string"},"functionProps":["onPick"]}, {"module":"/src/elements/x.tsx","load":"load"});',
    );
  });

  it("サーバー向けの要素の登録には、要素のファイルの export const load の値をデフォルトの起動タイミングとして渡す", () => {
    const end = "export default function X(props: {}) { return <p />; }";
    for (const load of ["load", "idle", "visible"]) {
      expect(element(`export const load = "${load}";\n${end}`).code).toContain(
        `{"module":"/src/elements/x.tsx","load":"${load}"}`,
      );
    }
    expect(element(`export const load = 'idle';\n${end}`).code).toContain('"load":"idle"');
    expect(element(`export const load = "idle" as const;\n${end}`).code).toContain('"load":"idle"');
    expect(element(`export const load = "idle" satisfies string;\n${end}`).code).toContain(
      '"load":"idle"',
    );
  });

  it("export const load 以外の形で load を export すると、ビルドのエラーにする", () => {
    const end = "export default function X(props: {}) { return <p />; }";
    for (const source of [
      'const load = "idle";\nexport { load };',
      'const mode = "idle";\nexport { mode as load };',
      'export { load } from "./mode.ts";',
      'export let load = "idle";',
      'export var load = "idle";',
      'const mode = { load: "idle" };\nexport const { load } = mode;',
    ]) {
      expect(() => element(`${source}\n${end}`)).toThrow(/export const load/);
    }
  });

  it("export const load の値が load、idle、visible の文字列のリテラルでなければ、ビルドのエラーにする", () => {
    const end = "export default function X(props: {}) { return <p />; }";
    for (const value of ['"media"', '"media:(min-width: 800px)"', '"later"', "mode", "`idle`"]) {
      expect(() => element(`const mode = "idle";\nexport const load = ${value};\n${end}`)).toThrow(
        /export const load/,
      );
    }
  });

  it("クライアント向けの要素のモジュールは、内部の入口の登録の関数に import.meta.hot を渡し、自身の更新を受け入れる", () => {
    const code = `export default function X(props: { a: string }) { return <p />; }`;
    const client = transformSource(code, {
      id: "src/elements/x.tsx",
      file: "src/elements/x.tsx",
      lang: "tsx",
      client: true,
      element: { tag: "app-x", module: "/src/elements/x.tsx" },
    }).code;
    expect(client).toContain(
      'export default __rinka_defineElement("app-x", X, {"props":["a"],"types":{"a":"string"}}, import.meta.hot);',
    );
    expect(client).toContain(
      'import { defineElement as __rinka_defineElement } from "rinka/internal";',
    );
    expect(client).toContain("if (import.meta.hot) import.meta.hot.accept();");
    expect(element(code).code).not.toContain("import.meta.hot");
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

/** 要素のファイル `code` を変換し、登録の設定の `form` を返す。 */
const form = (code: string) => element(code).element?.options.form;

describe("フォームの部品の判別", () => {
  it("ctx の form を、分割代入の引数、メンバーの参照、関数の中の分割代入で使用すると、フォームの部品にする", () => {
    expect(form("export default function X(props: {}, { form }: Ctx) { return null; }")).toBe(true);
    expect(
      form("export default function X(props: {}, { form: f, host }: Ctx) { return null; }"),
    ).toBe(true);
    expect(
      form(
        'export default function X(props: {}, ctx: Ctx) { ctx.form.value(() => "a"); return null; }',
      ),
    ).toBe(true);
    expect(
      form(
        "export default function X(props: {}, ctx: Ctx) { const { form } = ctx; return () => form.disabled(); }",
      ),
    ).toBe(true);
    expect(
      element("export default function X(props: {}, { form }: Ctx) { return null; }").code,
    ).toContain('{"props":[],"form":true}');
  });

  it("form を使用しない要素は、フォームの部品にしない", () => {
    expect(form("export default function X(props: {}) { return null; }")).toBeUndefined();
    expect(
      form("export default function X(props: {}, { host, internals }: Ctx) { return null; }"),
    ).toBeUndefined();
    expect(
      form(
        "export default function X(props: {}, ctx: Ctx) { const { host } = ctx; ctx.onMount(() => {}); return null; }",
      ),
    ).toBeUndefined();
  });

  it("括弧と型の記述で包んだ ctx の参照と、デフォルト値を持つ引数も判別する", () => {
    for (const use of [
      "(ctx).form",
      "(ctx as Ctx).form",
      "(ctx satisfies Ctx).form",
      "ctx!.form",
    ]) {
      expect(
        form(`export default function X(props: {}, ctx: Ctx) { ${use}.disabled(); return null; }`),
        use,
      ).toBe(true);
    }
    expect(
      form(
        "export default function X(props: {}, ctx: Ctx) { const { form } = ctx as Ctx; return null; }",
      ),
    ).toBe(true);
    expect(
      form(
        "export default function X(props: {}, ctx: Ctx = {} as Ctx) { ctx.form.disabled(); return null; }",
      ),
    ).toBe(true);
  });

  it("内側の関数とブロックで宣言した同じ名前の変数は、ctx として扱わない", () => {
    const code = `export default function X(props: {}, ctx: Ctx) {
  ctx.onMount(() => { const ctx = canvas.getContext("2d"); draw(ctx); });
  const g = (ctx: number) => ctx + 1;
  { let ctx = 1; use(ctx); }
  try {} catch (ctx) { use(ctx); }
  for (const ctx of list) use(ctx);
  return null;
}`;
    expect(form(code)).toBeUndefined();
    expect(() => element(code.replace("return null;", "use(ctx); return null;"))).toThrow(/ctx/);
  });

  it("ctx をメンバーの参照と分割代入以外で使用すると、ビルドのエラーにする", () => {
    const wrong = [
      "export default function X(props: {}, ctx: Ctx) { const key = 'form'; ctx[key]; return null; }",
      "export default function X(props: {}, ctx: Ctx) { setup(ctx); return null; }",
      "export default function X(props: {}, ctx: Ctx) { const c = ctx; return null; }",
      "export default function X(props: {}, ctx: Ctx) { const { ...rest } = ctx; return null; }",
      "export default function X(props: {}, { ...rest }: Ctx) { return null; }",
      "export default function X(props: {}, { ['form']: f }: Ctx) { return null; }",
      "export default function X(props: {}, [a]: any) { return null; }",
    ];
    for (const code of wrong) expect(() => element(code), code).toThrow(/ctx/);
  });
});

/** 元のソースを変換したコード `code` に、oxc の JSX の変換と、JSX の規則を適用する。 */
async function lower(code: string, file: string): Promise<string> {
  const lowered = await transformWithOxc(code, file, { lang: "tsx", ...oxc });
  return transformJsx(lowered.code, { id: file, file }).code;
}

/** サーバーのソース `path` を import する指定子を、JS の文字列のリテラルにする。 */
const runtime = (path: string): string => JSON.stringify(pathToFileURL(resolve(path)).href);

/** `code` に、元のソースの変換、oxc の JSX の変換、JSX の規則の順に適用し、注釈を除いて空白をまとめたコードを返す。 */
async function compile(code: string, options: Partial<SourceOptions> = {}): Promise<string> {
  const file = options.file ?? "src/routes/page.tsx";
  const source = transformSource(code, { id: file, file, lang: "tsx", client: false, ...options });
  return (await lower(source.code, file))
    .replaceAll("/* @__PURE__ */ ", "")
    .replaceAll(/\s+/g, " ");
}

describe("JSX のリアクティブ化", () => {
  it("ネイティブのタグの属性と子は、関数呼び出しかプロパティ参照を含む式だけを関数で包む", async () => {
    const code =
      await compile(`const view = <div class={{ active: on() }} title="t" id={id} onClick={() => f()}
  onInput={props.onInput} ref={r} key={k} style={s.value} data-n={1}>
  {user().name}{count}{"lit"}<b />{cond() ? <i /> : null}{flag && <p>{x()}</p>}{tag\`a\`}
</div>;`);
    expect(code).toContain("class: () => ({ active: on() })");
    expect(code).toContain('title: "t"');
    expect(code).toContain("id,");
    expect(code).toContain("onClick: () => f()");
    expect(code).toContain("onInput: props.onInput");
    expect(code).toContain("ref: r");
    expect(code).toContain("style: () => (s.value)");
    expect(code).toContain('"data-n": 1');
    expect(code).toContain("() => (user().name)");
    expect(code).toContain('count, "lit", _jsx("b", {})');
    expect(code).toContain('() => (cond() ? _jsx("i", {}) : null)');
    expect(code).toContain('flag && _jsx("p", { children: () => (x()) })');
    expect(code).toContain("() => (tag`a`)");
  });

  it("コンポーネントに渡す props と children は、リテラルと関数を除いて getter にする", async () => {
    const code = await compile(
      `const view = <Loading fallback={<p>l</p>} n={2} pick={() => 1} v={props.v} id={id} ref={r} load:visible>{user()}</Loading>;`,
    );
    expect(code).toContain('get fallback() { return (_jsx("p", { children: "l" })); }');
    expect(code).toContain("n: 2");
    expect(code).toContain("pick: () => 1");
    expect(code).toContain("get v() { return (props.v); }");
    expect(code).toContain("get id() { return (id); }");
    expect(code).toContain("ref: r");
    expect(code).toContain('"load:visible": true');
    expect(code).toContain("get children() { return (user()); }");
  });

  it("値の中に await があれば、関数で包まず、getter にもしない", async () => {
    const code = await compile(
      `async function Page() { return <main><h1>{await greet()}</h1><Card title={await t()} n={x.y} onPick={async () => await save()} /></main>; }`,
    );
    expect(code).toContain("children: await greet()");
    expect(code).toContain("title: await t()");
    expect(code).toContain("get n() { return (x.y); }");
    expect(code).toContain("onPick: async () => await save()");
  });
});

describe("スロット化", () => {
  it("要素のファイルでは、props.children とスロットの props を <slot> にする", async () => {
    const code = await compile(
      `type Props = { header?: JSX.Element; footer?: JSX.Element; children?: JSX.Element };
export default function X(props: Props) {
  return <section><header>{props.header ?? <h2>t</h2>}</header><Loading>{props.children}</Loading><div>{props.footer}</div></section>;
}`,
      {
        id: "src/elements/x.tsx",
        file: "src/elements/x.tsx",
        element: { tag: "app-x", module: "/src/elements/x.tsx" },
      },
    );
    expect(code).toContain(
      '_jsx("slot", { name: "header", children: _jsx("h2", { children: "t" }) })',
    );
    expect(code).toContain('get children() { return (_jsx("slot", {})); }');
    expect(code).toContain('_jsx("slot", { name: "footer" })');
  });

  it("同じスロットを 2 回置くと、ビルドのエラーにする", () => {
    expect(() =>
      element(`type Props = { children?: JSX.Element };
export default function X(props: Props) { return <p>{props.children}{props.children}</p>; }`),
    ).toThrow(/2 回/);
  });

  it("デフォルトの中身の位置のスロットの参照は、ビルドのエラーにする", () => {
    expect(() =>
      element(`type Props = { header?: JSX.Element; children?: JSX.Element };
export default function X(props: Props) { return <p>{props.header ?? props.children}</p>; }`),
    ).toThrow(/スロット children は/);
  });

  it("括弧で囲んだ props のスロットの参照は、ビルドのエラーにする", () => {
    expect(() =>
      element(`type Props = { children?: JSX.Element };
export default function X(props: Props) { const x = (props).children; return <p>{x}</p>; }`),
    ).toThrow(/スロット children は/);
  });

  it("デフォルトの中身の JSX の子に置いたスロットも、<slot> にする", async () => {
    const code = await compile(
      `type Props = { header?: JSX.Element; children?: JSX.Element };
export default function X(props: Props) { return <p>{props.header ?? <div>{props.children}</div>}</p>; }`,
      {
        id: "src/elements/x.tsx",
        file: "src/elements/x.tsx",
        element: { tag: "app-x", module: "/src/elements/x.tsx" },
      },
    );
    expect(code).toContain('_jsx("slot", { name: "header", children: _jsx("div", {');
    expect(code).toContain('_jsx("slot", {})');
  });

  it("要素でないファイルの props.children は、そのまま関数で包む", async () => {
    expect(
      await compile(`function Layout(props) { return <main>{props.children}</main>; }`),
    ).toContain("children: () => (props.children)");
  });
});

describe("変換したコードの描画", () => {
  it("変換した要素とページを、サーバーのレンダラーで描画する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rinka-compiler-"));
    /** 変換したコードの `rinka` の import をサーバーのソースに置き換えて、`dir` の `name` として読み込む。 */
    const load = async (code: string, name: string): Promise<{ default: unknown }> => {
      const path = join(dir, name);
      await writeFile(
        path,
        code
          .replaceAll('"rinka/jsx-runtime"', runtime("src/server/jsx-runtime.ts"))
          .replaceAll('"rinka/internal"', runtime("src/server/internal.ts"))
          .replaceAll('"rinka"', runtime("src/server/index.ts")),
      );
      return (await import(pathToFileURL(path).href)) as { default: unknown };
    };
    try {
      const card = transformSource(
        `import { signal } from "rinka";
type Props = { heading: string; children?: JSX.Element };
export default function Card(props: Props) {
  const [count] = signal(2);
  return <section><h2>{props.heading}</h2><p>{count() * 2}</p><div>{props.children}</div></section>;
}`,
        {
          id: "src/elements/card.tsx",
          file: "src/elements/card.tsx",
          lang: "tsx",
          client: false,
          element: { tag: "app-card", module: "/src/elements/card.tsx" },
        },
      );
      await load(await lower(card.code, "src/elements/card.tsx"), "card.js");
      const page = transformSource(
        `import Card from "./card.js";
export default function Page() { return <main><Card heading={"h" + 1}>body</Card></main>; }`,
        { id: "src/routes/page.tsx", file: "src/routes/page.tsx", lang: "tsx", client: false },
      );
      const { default: Page } = await load(
        await lower(page.code, "src/routes/page.tsx"),
        "page.js",
      );
      expect(await renderToString(jsx(Page as () => unknown, {}))).toBe(
        '<main><app-card data-oh="h1" heading="h1"><template shadowrootmode="open"><section><h2>h1</h2><p>4</p><div><slot></slot></div></section></template>body</app-card></main>',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("JSX の規則の細部", () => {
  it("内側の関数の中の呼び出しと await は、判定に含めない", async () => {
    const code = await compile(
      `const view = <div data-f={() => f()}>{items.map(async (x) => await f(x))}</div>;`,
    );
    expect(code).toContain('"data-f": () => f()');
    expect(code).toContain("children: () => (items.map(async (x) => await f(x)))");
  });

  it("this と arguments を含む値と、括弧で囲んだ関数と、負の数は getter にしない", async () => {
    const code = await compile(
      `function F() { return <C v={this.x} a={arguments[0]} w={() => this.y} f={(() => 1)} n={-1} />; }`,
    );
    expect(code).toContain("v: this.x");
    expect(code).toContain("a: arguments[0]");
    expect(code).toContain("w: () => this.y");
    expect(code).toContain("f: (() => 1)");
    expect(code).toContain("n: -1");
  });

  it("内側のアロー関数の this は数え、内側の通常の関数の this と、プロパティ名の arguments は数えない", async () => {
    const code = await compile(
      `function F() { return <C a={items.map(() => this.y)} b={items.map(function () { return this.y; })} c={x.arguments} />; }`,
    );
    expect(code).toContain("a: items.map(() => this.y)");
    expect(code).toContain("get b() { return (items.map(function() {");
    expect(code).toContain("get c() { return (x.arguments); }");
  });

  it("jsx に渡す 1 つの子の配列は、配列の全体で判定する", async () => {
    expect(await compile(`const view = <div>{[a(), b]}</div>;`)).toContain(
      "children: () => ([a(), b])",
    );
  });

  it("スプレッドの後に記述した key は、ビルドのエラーにする", async () => {
    await expect(compile(`const view = <C {...p} key={k} />;`)).rejects.toThrow(/key/);
  });
});

describe("要素の呼び出し箇所の ID", () => {
  it("コンポーネントの JSX の呼び出しに、元のソースのファイルと行と列の ID を付与する", async () => {
    const code = await compile(`const a = <C n={1} />;
const b = <ui.Card key={k}><C /></ui.Card>;
const c = <div><>{x}</></div>;`);
    expect(code).toContain('_jsx(C, { n: 1 }, void 0, "src/routes/page.tsx:1:11")');
    expect(code).toContain(
      '_jsx(ui.Card, { get children() { return (_jsx(C, {}, void 0, "src/routes/page.tsx:2:28")); } }, k, "src/routes/page.tsx:2:11")',
    );
    expect(code).toContain('_jsx("div", { children: _jsx(_Fragment, { children: x }) })');
    expect(code).not.toContain("__rinka_site");
  });

  it("クライアント向けとサーバー向けで、同じ呼び出しに同じ ID を付与する", async () => {
    const source = `import { defineServerFn } from "rinka/server";
export const f = defineServerFn(async () => { await g(); return 1; });
export async function view() { return <C v={await f()} />; }`;
    const site = '"src/lib/view.tsx:3:39"';
    const options = { file: "src/lib/view.tsx" };
    expect(await compile(source, { ...options, client: true })).toContain(site);
    expect(await compile(source, { ...options, client: false })).toContain(site);
  });

  it("型引数を持つコンポーネントにも付与し、名前に - を含むタグには付与しない", async () => {
    const code = await compile(`const a = <C<string> v="x" />;
const b = <Foo-bar />;`);
    expect(code).toContain('_jsx(C, { v: "x" }, void 0, "src/routes/page.tsx:1:11")');
    expect(code).toContain('_jsx("Foo-bar", {})');
  });

  it("要素のファイルのスロットのデフォルトの中身の呼び出しにも、クライアント向けとサーバー向けで同じ ID を付与する", async () => {
    const source = `import D from "./d.tsx";
type Props = { header?: JSX.Element };
export default function X(props: Props) { return <p>{props.header ?? <D n={2} />}</p>; }`;
    const options = {
      file: "src/elements/x.tsx",
      element: { tag: "app-x", module: "/src/elements/x.tsx" },
    };
    const site = '"src/elements/x.tsx:3:70"';
    expect(await compile(source, { ...options, client: true })).toContain(site);
    expect(await compile(source, { ...options, client: false })).toContain(site);
  });

  it("JSX に __rinka_site を記述すると、ビルドのエラーにする", async () => {
    await expect(compile(`const a = <C __rinka_site="x" />;`)).rejects.toThrow(/__rinka_site/);
  });
});

/** `body` を本体に持つ要素の関数のファイルを変換したコードを返す。 */
const slotted = (body: string) =>
  element(`type Props = { children?: JSX.Element };
export default function X(props: Props) { ${body} }`).code;

describe("スロット化の範囲", () => {
  it("props と同じ名前の引数を持つ内側の関数の中は変換しない", () => {
    const code = slotted(
      "const Inner = (props: { children?: unknown }) => <b>{props.children}</b>; return <p><Inner>hi</Inner>{props.children}</p>;",
    );
    expect(code).toContain("<b>{props.children}</b>");
    expect(code).toContain(">hi</Inner><slot /></p>");
  });

  it("要素の関数の中の関数にスロットを置くと、ビルドのエラーにする", () => {
    expect(() => slotted("return <ul>{items.map((i) => <li>{props.children}</li>)}</ul>;")).toThrow(
      /関数の中の関数/,
    );
  });

  it("<slot> にできない位置でスロットの props を参照すると、ビルドのエラーにする", () => {
    for (const body of [
      "return <p>{show ? props.children : null}</p>;",
      "return <p>{[props.children]}</p>;",
      "return <p>{() => props.children}</p>;",
      "const content = props.children; return <p>{content}</p>;",
      "const { children } = props; return <p>{children}</p>;",
      'return <p>{props["children"]}</p>;',
    ]) {
      expect(() => slotted(body), body).toThrow(/スロット children は/);
    }
  });

  it("props 以外の値の children の参照は、ビルドのエラーにしない", () => {
    expect(() =>
      slotted(
        "const p = props; const items = [{ children: 1 }]; return <ul>{items.map((p) => <li>{p.children}</li>)}{p.label}</ul>;",
      ),
    ).not.toThrow();
  });
});

describe("括弧で囲んだ式", () => {
  it("括弧で囲んだ式の本体、await、memo の引数を、括弧ごと変換する", () => {
    const body = module("export const f = async () => ({ a: await x });", true);
    expect(body).toContain("return ({ a: await __rinka_stop(x) }); }");
    expect(module("export const f = async () => { await (a, b); };", true)).toContain(
      "await __rinka_stop((a, b))",
    );
    expect(
      module("export const f = async () => { for await (const v of (a, b)); };", true),
    ).toContain("__rinka_stop.iterate((a, b))");
    const memoCall = 'import { memo } from "rinka"; memo((a, b)); memo(f, (a, b));';
    expect(module(memoCall)).toContain('memo((a, b), { site: "src/lib/a.ts:1:31" })');
    expect(module(memoCall)).toContain('memo(f, { ...(a, b), site: "src/lib/a.ts:1:45" })');
  });

  it("括弧で囲んだ props.children も <slot> にする", () => {
    expect(slotted("return <p>{(props.children)}</p>;")).toContain("<p><slot /></p>");
  });

  it("コンポーネントに渡す括弧で囲んだ値は、括弧ごと getter にする", async () => {
    expect(await compile("const view = <C a={(x, y)} />;")).toContain(
      "get a() { return ((x, y)); }",
    );
  });

  it("構文の誤りのエラーは、ルートからの相対パスを表示する", () => {
    const source = {
      id: "/root/src/lib/a.ts",
      file: "src/lib/a.ts",
      lang: "ts",
      client: false,
    } as const;
    expect(() => transformSource("const = ;", source)).toThrow(/^src\/lib\/a\.ts を解析できません/);
    expect(() => transformJsx("const = ;", source)).toThrow(/^src\/lib\/a\.ts を解析できません/);
  });
});

describe("サーバー関数の定義", () => {
  const source = `import { defineMiddleware, defineServerFn as define } from "rinka/server";
import { db } from "./db.ts";
import { schema, limit } from "./schema.ts";
import type { User } from "./user.ts";
import "./side-effect.ts";
const auth = defineMiddleware(async (c, next) => { await next(); });
export const like = define({ input: schema })(auth, async (c, { input }) => db.like(input));
const getUser = define({ method: "GET" })(async (): Promise<User> => db.users.find());
export const ping = define(auth, () => "pong");
export const config = { db: 1, limit };
`;

  it("サーバー向けでは、定義の式を ID で登録する呼び出しで包む", () => {
    const code = module(source);
    expect(code).toContain(
      'import { serverFnModule as __rinka_serverFnModule } from "rinka/internal"; const __rinka_registerServerFn = __rinka_serverFnModule("src/lib/a.ts");',
    );
    expect(code).toContain(
      'export const like = __rinka_registerServerFn("src/lib/a.ts#like", define({ input: schema })(auth, async (c, { input }) => db.like(input)));',
    );
    expect(code).toContain(
      'const getUser = __rinka_registerServerFn("src/lib/a.ts#getUser", define(',
    );
    expect(code).toContain(
      'export const ping = __rinka_registerServerFn("src/lib/a.ts#ping", define(auth, () => "pong"));',
    );
    expect(code).toContain("const auth = defineMiddleware(");
  });

  it("ID のモジュールの部分を指定すると、サーバー向けの登録とクライアント向けの RPC の呼び出しは、その値を ID に使用する", () => {
    const options = {
      id: "src/lib/a.ts",
      file: "src/lib/a.ts",
      lang: "ts",
      fnModule: "mabc",
    } as const;
    const server = transformSource(source, { ...options, client: false });
    const client = transformSource(source, { ...options, client: true });
    expect(server.code).toContain('__rinka_registerServerFn("mabc#like",');
    expect(client.code).toContain('__rinka_serverFn("mabc#like", "POST")');
    expect(server.serverFns).toEqual(["mabc#like", "mabc#getUser", "mabc#ping"]);
  });

  it("メソッドを省略した定義の出力のメソッドは、defineServerFn の実行時のデフォルトのメソッドと一致する", () => {
    const code = module(
      'import { defineServerFn } from "rinka/server";\nexport const fn = defineServerFn(() => null);\n',
      true,
    );
    expect(code).toContain(
      `__rinka_serverFn("src/lib/a.ts#fn", "${definitionOf(defineServerFn(() => null))?.method}")`,
    );
  });

  it("クライアント向けでは、定義の式を RPC の関数を作る呼び出しに、ミドルウェアの定義を undefined に置換し、使用されなくなった import を除去する", () => {
    const code = module(source, true);
    expect(code).toContain('import { serverFn as __rinka_serverFn } from "rinka/internal";');
    expect(code).toContain('export const like = __rinka_serverFn("src/lib/a.ts#like", "POST");');
    expect(code).toContain('const getUser = __rinka_serverFn("src/lib/a.ts#getUser", "GET");');
    expect(code).toContain('export const ping = __rinka_serverFn("src/lib/a.ts#ping", "POST");');
    expect(code).toContain("const auth = undefined;");
    expect(code).not.toContain("rinka/server");
    expect(code).not.toContain("./db.ts");
    expect(code).toContain('import { limit } from "./schema.ts";');
    expect(code).toContain('import "./side-effect.ts";');
  });

  it("import が使用されているかどうかの判定では、オブジェクトのキーとプロパティの名前を数えない", () => {
    const code = module(
      `import { defineServerFn } from "rinka/server";
import { secret, kept } from "./secret.ts";
export const fn = defineServerFn(() => secret);
export const a = { secret: 1, kept };
export const b = (config: { secret: number }) => config.secret;
export class C { secret = 1; secret2() {} }`,
      true,
    );
    expect(code).toContain('import { kept } from "./secret.ts";');
  });

  it("enum の初期化子と import = の右辺の参照は、import の使用として数える", () => {
    const code = module(
      `import { defineServerFn } from "rinka/server";
import { secret, ns } from "./values.ts";
export const fn = defineServerFn(() => [secret, ns]);
export enum E { A = secret }
import A = ns.B;
export { A };`,
      true,
    );
    expect(code).toContain('import { secret, ns } from "./values.ts";');
  });

  it("サーバー関数の定義からだけ使用していた、トップレベルの関数と、関数で初期化した const を除去する", () => {
    const code = module(
      `import { defineServerFn } from "rinka/server";
import { db } from "./db.ts";
import { format } from "./format.ts";
function load() { return db.find(); }
const query = () => load();
const label = (value: string) => format(value);
export const fn = defineServerFn(() => query());
export const shown = label("x");`,
      true,
    );
    expect(code).not.toContain("./db.ts");
    expect(code).not.toContain("function load");
    expect(code).not.toContain("const query");
    expect(code).toContain("const label = (value: string) => format(value);");
    expect(code).toContain('import { format } from "./format.ts";');
  });

  it("rinka/server を名前を指定せずに import すると、ビルドのエラーにする", () => {
    for (const statement of [
      'import * as server from "rinka/server";',
      'import server from "rinka/server";',
    ]) {
      expect(() =>
        module(`${statement}\nexport const fn = server.defineServerFn(() => 1);`, true),
      ).toThrow(CompileError);
    }
  });

  it("クライアント向けでは、定義の式の中だけで使用した rinka/server の値の import を除去し、型だけの import を残す", () => {
    const code = module(
      `import type * as Server from "rinka/server";
import { defineMiddleware, defineServerFn } from "rinka/server";
export type M = Server.ServerFnMethod;
export const fn = defineServerFn({ method: "GET" })(defineMiddleware(async (_c, next) => next()), () => 1);`,
      true,
    );
    expect(code).toContain('export const fn = __rinka_serverFn("src/lib/a.ts#fn", "GET");');
    expect(code).not.toContain("defineMiddleware");
    expect(code).toContain('import type * as Server from "rinka/server";');
  });

  it("method は、1 段目のオブジェクトの文字列のリテラルから読み取る", () => {
    const code = module(
      `import { defineServerFn } from "rinka/server";
export const a = defineServerFn({ method: "GET" as const })(() => 1);
export const b = defineServerFn({ input: (v: number) => v })(() => 1);`,
      true,
    );
    expect(code).toContain('export const a = __rinka_serverFn("src/lib/a.ts#a", "GET");');
    expect(code).toContain('export const b = __rinka_serverFn("src/lib/a.ts#b", "POST");');
  });

  it("method を静的に読み取れなければ、ビルドのエラーにする", () => {
    for (const options of [
      "options",
      "{ method }",
      "{ ...options }",
      '{ method: "PUT" }',
      '{ ["method"]: "GET" }',
    ]) {
      expect(() =>
        module(
          `import { defineServerFn } from "rinka/server";
const method = "GET"; const options = {};
export const a = defineServerFn(${options})(() => 1);`,
          true,
        ),
      ).toThrow(CompileError);
    }
  });

  it("トップレベルの const の初期化の式以外で defineServerFn を使用すると、ビルドのエラーにする", () => {
    for (const body of [
      "export let a = defineServerFn(() => 1);",
      "function f() { const a = defineServerFn(() => 1); return a; }",
      "export const a = [defineServerFn(() => 1)];",
      "export const { a } = defineServerFn(() => 1);",
      "export default defineServerFn(() => 1);",
      "const define = defineServerFn;",
    ]) {
      for (const client of [false, true]) {
        expect(() =>
          module(`import { defineServerFn } from "rinka/server";\n${body}`, client),
        ).toThrow(CompileError);
      }
    }
  });
});
