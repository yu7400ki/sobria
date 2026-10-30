import { flush } from "@solidjs/signals";
import { afterEach, describe, expect, it } from "vitest";

import { defineElement } from "../../src/client/element.ts";
import { createSheet, updateSheet } from "../../src/client/styles.ts";
import { bootstrapSource } from "../../src/server/bootstrap.ts";
import { defineElement as defineServer } from "../../src/server/element.ts";
import { jsx as serverJsx } from "../../src/server/jsx-runtime.ts";
import { renderToStream } from "../../src/server/response.ts";
import { serverSheet } from "../../src/server/styles.ts";
import type { Ctx } from "../../src/shared/element.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let count = 0;
const nextTag = () => `test-styled-${++count}`;

afterEach(() => {
  document.body.replaceChildren();
  delete (globalThis as { $sobria?: unknown }).$sobria;
});

/** `html` を `document.body` に配置し、要素が起動するまで待つ。 */
async function place(html: string): Promise<void> {
  document.body.innerHTML = html;
  await tick();
  flush();
  await tick();
  flush();
}

/** `node` を SSR した HTML を、起動スクリプトとともに `document.body` に配置する。 */
async function serve(node: unknown): Promise<void> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of renderToStream(node)) text += decoder.decode(chunk);
  // oxlint-disable-next-line typescript/no-implied-eval
  new Function(bootstrapSource)();
  const body = text.slice(text.indexOf("<body>") + 6, text.indexOf("</body>"));
  const container = document.createElement("div");
  container.setHTMLUnsafe(body.replaceAll(/<script>.*?<\/script>/gs, ""));
  document.body.append(container);
}

/** :host に display: block を適用する要素の関数。 */
const blockHost = (_props: object, { css }: Ctx) => {
  css`
    :host {
      display: block;
    }
  `;
  return null;
};

describe("ctx の css", () => {
  it("css に渡したシートを、呼び出した順に adoptedStyleSheets にする", async () => {
    const tag = nextTag();
    const shared = new CSSStyleSheet();
    shared.replaceSync("p { color: red }");
    defineElement(
      tag,
      (_props: object, { css }: Ctx) => {
        css`
          :host {
            display: block;
          }
        `;
        css(shared);
        css`
          p {
            margin: ${4}px;
          }
        `;
        return null;
      },
      { props: {} },
    );
    await place(`<${tag}></${tag}>`);
    const sheets = document.querySelector(tag)!.shadowRoot!.adoptedStyleSheets;
    expect(sheets.map((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))).toEqual([
      [":host { display: block; }"],
      ["p { color: red; }"],
      ["p { margin: 4px; }"],
    ]);
    expect(sheets[1]).toBe(shared);
  });

  it("埋め込む値の無いタグ付きテンプレートのシートは、インスタンスの間で共有し、値のあるものはインスタンスごとに作成する", async () => {
    const tag = nextTag();
    defineElement(
      tag,
      (_props: object, { css }: Ctx) => {
        css`
          :host {
            display: block;
          }
        `;
        css`
          :host {
            order: ${1};
          }
        `;
        return null;
      },
      { props: {} },
    );
    await place(`<${tag}></${tag}><${tag}></${tag}>`);
    const [a, b] = [...document.querySelectorAll(tag)].map(
      (host) => host.shadowRoot!.adoptedStyleSheets,
    );
    expect(a![0]).toBe(b![0]);
    expect(a![1]).not.toBe(b![1]);
  });

  it("SSR した要素を引き継ぐと、DSD の <style> と <link> を adoptedStyleSheets に置換する", async () => {
    const tag = nextTag();
    const sheet = serverSheet("data:text/css,");
    const server = defineServer(
      tag,
      (props: object, ctx: Ctx) => {
        ctx.css(sheet as unknown as CSSStyleSheet);
        return blockHost(props, ctx);
      },
      { props: {} },
    );
    await serve(serverJsx(server, {}));
    const host = document.querySelector(tag)!;
    expect(host.shadowRoot!.querySelector("style")).not.toBeNull();
    expect(host.shadowRoot!.querySelector("link")).not.toBeNull();
    defineElement(tag, blockHost, { props: {} });
    await tick();
    flush();
    await tick();
    flush();
    expect(host.shadowRoot!.querySelector("style")).toBeNull();
    expect(host.shadowRoot!.querySelector("link")).toBeNull();
    expect(host.shadowRoot!.adoptedStyleSheets).toHaveLength(1);
    expect(getComputedStyle(host).display).toBe("block");
  });
});

describe("クライアントのシート", () => {
  it("createSheet と updateSheet は、CSS をシートにする", () => {
    const sheet = createSheet(".a { color: red; }");
    expect([...sheet.cssRules].map((rule) => rule.cssText)).toEqual([".a { color: red; }"]);
    updateSheet(sheet, ".b { color: blue; }");
    expect([...sheet.cssRules].map((rule) => rule.cssText)).toEqual([".b { color: blue; }"]);
  });
});
