import { afterEach, describe, expect, it, vi } from "vitest";

import { Errored, Loading } from "../../src/server/control.ts";
import { defineElement } from "../../src/server/element.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToResponse, renderToString } from "../../src/server/render.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** `node` を文書として描画し、`<head>` の中身と `<body>` の中身を返す。 */
async function documentOf(node: unknown): Promise<{ head: string; body: string }> {
  const html = await (await renderToResponse(node)).text();
  const match = /^<!doctype html><html><head>(.*)<\/head><body>(.*)<\/body><\/html>$/s.exec(html);
  if (!match) throw new Error(`文書の形ではありません: ${html}`);
  return { head: match[1] ?? "", body: match[2] ?? "" };
}

const title = (text: string) => jsx("title", { children: text });

/** `ms` ミリ秒の後に `node` を返すコンポーネントである。 */
const later = (ms: number, node: unknown) => async () => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return node;
};

const Failing = async () => {
  await Promise.resolve();
  throw new Error("failed");
};

const Titled = defineElement(
  "x-titled",
  () => [title("inner"), jsx("link", { rel: "stylesheet", href: "/x.css" })],
  {
    props: [],
  },
);

describe("文書の <head>", () => {
  it("シェルの中かつ要素の外の <title>、<meta>、<link> を、<head> に移動する", async () => {
    const { head, body } = await documentOf(
      jsx("main", {
        children: [
          title("Home"),
          jsx("meta", { name: "description", content: "d" }),
          jsx("link", { rel: "icon", href: "/i.png" }),
          "text",
        ],
      }),
    );
    expect(head).toBe(
      '<meta charset="utf-8"><title>Home</title><meta name="description" content="d"><link rel="icon" href="/i.png">',
    );
    expect(body).toBe("<main>text</main>");
  });

  it("移動したタグは、非同期のコンポーネントを含めて、文書の順序で並べる", async () => {
    const { head } = await documentOf([
      jsx("link", { rel: "stylesheet", href: "/a.css" }),
      jsx(later(20, jsx("link", { rel: "stylesheet", href: "/b.css" })), {}),
      jsx("link", { rel: "stylesheet", href: "/c.css" }),
    ]);
    expect(head).toBe(
      '<meta charset="utf-8"><link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css"><link rel="stylesheet" href="/c.css">',
    );
  });

  it("<Errored> が受け止めた部分のタグを除き、フォールバックのタグを移動する", async () => {
    const { head } = await documentOf(
      jsx(Errored, {
        fallback: () => title("failed"),
        children: [title("ok"), jsx(Failing, {})],
      }),
    );
    expect(head).toBe('<meta charset="utf-8"><title>failed</title>');
  });

  it("<Loading> の内側のタグは、中身がシェルに揃ったときも移動せず、開発時に警告する", async () => {
    vi.stubEnv("DEV", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { head, body } = await documentOf(
      jsx(Loading, { fallback: "wait", children: title("inner") }),
    );
    expect(head).toBe('<meta charset="utf-8">');
    expect(body).toBe("<title>inner</title>");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("<title>"));
  });

  it("後送りにした <Loading> のフォールバックのタグは移動し、中身のタグは移動しない", async () => {
    const { head, body } = await documentOf(
      jsx(Loading, { fallback: title("wait"), children: jsx(later(10, title("done")), {}) }),
    );
    expect(head.startsWith('<meta charset="utf-8"><title>wait</title><script>')).toBe(true);
    expect(head).not.toContain("done");
    expect(body).toContain("<title>done</title>");
  });

  it("要素の中のタグは移動せず、<title> と <meta> だけを開発時に警告する", async () => {
    vi.stubEnv("DEV", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { head, body } = await documentOf(jsx(Titled, {}));
    expect(head).not.toContain("<title>");
    expect(body).toContain('<title>inner</title><link rel="stylesheet" href="/x.css">');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("<title>"));
  });

  it("開発時でなければ警告しない", async () => {
    vi.stubEnv("DEV", false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await documentOf(jsx(Loading, { fallback: "wait", children: title("inner") }));
    expect(warn).not.toHaveBeenCalled();
  });

  it("renderToString は、タグを記述した位置に出力する", async () => {
    expect(await renderToString(jsx("main", { children: title("Home") }))).toBe(
      "<main><title>Home</title></main>",
    );
  });
});
