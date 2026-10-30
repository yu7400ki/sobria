import { describe, expect, it } from "vitest";

import { Errored, Loading } from "../../src/server/control.ts";
import { defineElement as definePlain } from "../../src/server/element.ts";
import { defineElement } from "../../src/server/internal.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToStream } from "../../src/server/response.ts";
import type { DefaultLoad } from "../../src/shared/element.ts";
import { read } from "./stream-order.ts";

/** `tag` の名前で、モジュールの URL とデフォルトの起動タイミングを持つ要素を作成する。 */
const element = (tag: string, load: DefaultLoad = "load", body: unknown = jsx("p", {})) =>
  defineElement(
    tag,
    () => body,
    { props: { children: "slot" } },
    { module: `/src/elements/${tag}.tsx`, load },
  );

/** `tag` の名前で、モジュールと、共有するチャンクと、自身のチャンクを持つ要素を作成する。 */
const chunked = (tag: string) =>
  defineElement(
    tag,
    () => null,
    { props: {} },
    {
      module: `/assets/${tag}.js`,
      load: "load",
      chunks: ["/assets/shared.js", `/assets/${tag}-dep.js`],
    },
  );

/** `node` を描画した文書の全体を返す。 */
const html = async (node: unknown): Promise<string> => (await read(renderToStream(node))).join("");

/** 文書の `<head>` の中身を返す。 */
const head = (document: string): string =>
  document.slice(document.indexOf("<head>"), document.indexOf("</head>"));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("要素の配信", () => {
  it("すぐ起動するインスタンスがある要素のモジュールと、そのモジュールが静的に import するチャンクを、重複せずに先読みする", async () => {
    const document = await html(
      jsx("main", { children: [jsx(chunked("x-p"), {}), jsx(chunked("x-q"), {})] }),
    );
    expect(head(document)).toContain(
      '<link rel="modulepreload" href="/assets/x-p.js"><link rel="modulepreload" href="/assets/shared.js"><link rel="modulepreload" href="/assets/x-p-dep.js"><link rel="modulepreload" href="/assets/x-q.js"><link rel="modulepreload" href="/assets/x-q-dep.js"><script>',
    );
  });

  it("シェルで使用した要素を $sobria.m で伝え、すぐ起動するインスタンスがある要素だけを先読みする", async () => {
    const A = element("x-a");
    const B = element("x-b", "visible");
    const C = element("x-c", "visible");
    const D = element("x-d");
    const document = await html(
      jsx("main", {
        children: [
          jsx(A, {}),
          jsx(B, {}),
          jsx(C, { "load:load": true }),
          jsx(D, { "load:idle": true }),
        ],
      }),
    );
    expect(head(document)).toContain(
      '<link rel="modulepreload" href="/src/elements/x-a.tsx"><link rel="modulepreload" href="/src/elements/x-c.tsx"><script>$sobria.m([["x-a","/src/elements/x-a.tsx","load"],["x-b","/src/elements/x-b.tsx","visible"],["x-c","/src/elements/x-c.tsx","visible"],["x-d","/src/elements/x-d.tsx","load"]])</script>',
    );
    expect(head(document).indexOf("window.$sobria")).toBeLessThan(
      head(document).indexOf("$sobria.m("),
    );
  });

  it("load:* を data-sobria-load の属性にして出力する", async () => {
    const A = element("x-a");
    const document = await html(
      jsx("main", {
        children: [
          jsx(A, { "load:idle": true }),
          jsx(A, { "load:media": "(min-width: 800px)" }),
          jsx(A, {}),
        ],
      }),
    );
    expect(document).toContain('<x-a data-oh="h1" data-sobria-load="idle">');
    expect(document).toContain('<x-a data-oh="h2" data-sobria-load="media:(min-width: 800px)">');
    expect(document).toContain('<x-a data-oh="h3">');
  });

  it("loadTimings に無い load:* は属性にせず、要素のデフォルトの起動タイミングで先読みを判定する", async () => {
    const A = element("x-a");
    const document = await html(jsx(A, { "load:soon": true }));
    expect(document).toContain('<x-a data-oh="h1">');
    expect(head(document)).toContain('<link rel="modulepreload" href="/src/elements/x-a.tsx">');
  });

  it("同じタグは 1 度だけ伝え、先読みも 1 度だけ出力する", async () => {
    const A = element("x-a");
    const document = await html(jsx("main", { children: [jsx(A, {}), jsx(A, {})] }));
    expect(head(document).match(/modulepreload/g)).toHaveLength(1);
    expect(head(document)).toContain('$sobria.m([["x-a","/src/elements/x-a.tsx","load"]])');
  });

  it("要素の Shadow DOM の中の要素は伝えず、スロットに配置した要素は伝える", async () => {
    const Inner = element("x-inner");
    const Outer = element(
      "x-outer",
      "load",
      jsx("div", { children: [jsx(Inner, {}), jsx("slot", {})] }),
    );
    const Slotted = element("x-slotted", "idle");
    const document = await html(jsx(Outer, { children: jsx(Slotted, {}) }));
    expect(head(document)).toContain(
      '$sobria.m([["x-outer","/src/elements/x-outer.tsx","load"],["x-slotted","/src/elements/x-slotted.tsx","idle"]])',
    );
    expect(head(document)).not.toContain("x-inner");
  });

  it("後送りの境界で初めて現れた要素は、その境界のチャンクで、$sobria.r の前に伝える", async () => {
    const A = element("x-a");
    const E = element("x-e", "visible");
    const { promise, resolve } = Promise.withResolvers<void>();
    const Slow = async () => {
      await promise;
      return [jsx(A, {}), jsx(E, {})];
    };
    const reading = read(
      renderToStream(
        jsx("main", {
          children: [jsx(A, {}), jsx(Loading, { fallback: "wait", children: jsx(Slow, {}) })],
        }),
      ),
    );
    await tick();
    resolve();
    const document = (await reading).join("");
    expect(head(document)).toContain('$sobria.m([["x-a","/src/elements/x-a.tsx","load"]])');
    expect(head(document)).not.toContain("x-e");
    expect(document).toMatch(
      /<script>\$sobria\.m\(\[\["x-e","\/src\/elements\/x-e\.tsx","visible"\]\]\)<\/script><script>\$sobria\.r\(/,
    );
    expect(document.match(/"x-a","\/src/g)).toHaveLength(1);
  });

  it("配信の情報を持たない要素は伝えず、先読みもしない", async () => {
    const Plain = definePlain("x-plain", () => jsx("p", {}), { props: {} });
    const document = await html(jsx(Plain, {}));
    expect(document).not.toContain("$sobria.m(");
    expect(document).not.toContain("modulepreload");
  });
});

/** 描画に失敗するコンポーネントである。 */
const Boom = async () => {
  await Promise.resolve();
  throw new Error("boom");
};

describe("Errored の中の要素の配信", () => {
  it("Errored の中身が失敗して出力しなかった要素は伝えず、成功した中身の要素は伝える", async () => {
    const A = element("x-a");
    const B = element("x-b");
    const document = await html(
      jsx("main", {
        children: [
          jsx(Errored, { fallback: "err", children: [jsx(A, {}), jsx(Boom, {})] }),
          jsx(Errored, { fallback: "err", children: jsx(B, {}) }),
        ],
      }),
    );
    expect(head(document)).not.toContain("x-a");
    expect(head(document)).toContain(
      '<link rel="modulepreload" href="/src/elements/x-b.tsx"><script>$sobria.m([["x-b","/src/elements/x-b.tsx","load"]])</script>',
    );
  });
});
