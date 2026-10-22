import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { transformWithOxc } from "vite";
import { describe, expect, it } from "vitest";

import { CompileError, transformSource, type SourceOptions } from "../../src/build/compiler.ts";
import { oxc } from "../../src/build/entries.ts";
import { transformJsx } from "../../src/build/jsx.ts";
import { takeGate } from "../../src/client/internal.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToString } from "../../src/server/render.ts";
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

  it("クライアント向けのコードでも、式の本体の async 関数に付与する ID は、関門の外の memo の引数にする", () => {
    const code = module(
      `import { memo } from "rinka";
const a = memo(async () => get(await id()));`,
      true,
    );
    expect(code).toContain(
      'const a = memo(async () => { const __rinka_gate = __rinka_takeGate(); return get(await __rinka_gate(id())); }, { site: "src/lib/a.ts:2:11" });',
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

describe("await の関門", () => {
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
    expect(code).toContain(
      "export async function each() { const __rinka_gate = __rinka_takeGate(); for await (const v of __rinka_gate.iterate(source())) use(v); }",
    );
  });

  it("サーバー向けのコードと、async 関数の無いコードは関門で包まない", () => {
    expect(module(source)).not.toContain("__rinka");
    expect(module("export const x = 1;", true)).toBe("export const x = 1;");
  });

  it("関門は、シード中に取得したら解決しない Promise と、最初の値を返さない async iterable を返し、それ以外では値をそのまま返す", async () => {
    const value = Promise.resolve(1);
    expect(takeGate()(value)).toBe(value);
    const seeded = runSeeding(() => takeGate())(value);
    const later = new Promise((done) => setTimeout(() => done("pending"), 10));
    expect(await Promise.race([seeded.then(() => "settled"), later])).toBe("pending");
    const items = [1];
    expect(takeGate().iterate(items)).toBe(items);
    const iterator = runSeeding(() => takeGate()).iterate(items);
    const first = (iterator as AsyncIterable<never>)[Symbol.asyncIterator]().next();
    const waited = new Promise((done) => setTimeout(() => done("pending"), 10));
    expect(await Promise.race([first.then(() => "settled"), waited])).toBe("pending");
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
    expect(code).toContain('import { defineElement as __rinka_defineElement } from "rinka";');
    expect(code).toContain("function X(props: Props) { return <p />; }");
    expect(code).not.toContain("export default function");
    expect(code).toContain(
      'export default __rinka_defineElement("app-x", X, {"props":["a","onPick"],"types":{"a":"string"},"functionProps":["onPick"]});',
    );
  });

  it("クライアント向けの要素のモジュールは、import.meta.hot を登録に渡し、自身の更新を受け入れる", () => {
    const code = `export default function X(props: { a: string }) { return <p />; }`;
    const client = transformSource(code, {
      file: "src/elements/x.tsx",
      lang: "tsx",
      client: true,
      element: { tag: "app-x" },
    }).code;
    expect(client).toContain(
      'export default __rinka_defineElement("app-x", X, {"props":["a"],"types":{"a":"string"}}, import.meta.hot);',
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

/** 元のソースを変換したコード `code` に、oxc の JSX の変換と、JSX の規則を適用する。 */
async function lower(code: string, file: string): Promise<string> {
  const lowered = await transformWithOxc(code, file, { lang: "tsx", ...oxc });
  return transformJsx(lowered.code, file).code;
}

/** サーバーのソース `path` を import する指定子を、JS の文字列のリテラルにする。 */
const runtime = (path: string): string => JSON.stringify(pathToFileURL(resolve(path)).href);

/** `code` に、元のソースの変換、oxc の JSX の変換、JSX の規則の順に適用し、注釈を除いて空白をまとめたコードを返す。 */
async function compile(code: string, options: Partial<SourceOptions> = {}): Promise<string> {
  const file = options.file ?? "src/routes/page.tsx";
  const source = transformSource(code, { file, lang: "tsx", client: false, ...options });
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
      { file: "src/elements/x.tsx", element: { tag: "app-x" } },
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
        { file: "src/elements/card.tsx", lang: "tsx", client: false, element: { tag: "app-card" } },
      );
      await load(await lower(card.code, "src/elements/card.tsx"), "card.js");
      const page = transformSource(
        `import Card from "./card.js";
export default function Page() { return <main><Card heading={"h" + 1}>body</Card></main>; }`,
        { file: "src/routes/page.tsx", lang: "tsx", client: false },
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
    expect(code).toContain("<Inner>hi</Inner><slot /></p>");
  });

  it("要素の関数の中の関数にスロットを置くと、ビルドのエラーにする", () => {
    expect(() => slotted("return <ul>{items.map((i) => <li>{props.children}</li>)}</ul>;")).toThrow(
      /関数の中の関数/,
    );
  });
});
