import { fileURLToPath } from "node:url";

import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** docs のパッケージの Vite の設定で起動した、開発サーバーである。 */
let server: ViteDevServer;

beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true, ws: false },
    appType: "custom",
    logLevel: "silent",
  });
});

afterAll(() => server.close());

describe("MDX の描画", () => {
  it("生成した TSX を rinka でコンパイルし、サーバーで描画する", async () => {
    const { renderToString } = await server.ssrLoadModule("rinka/server");
    const content = await server.ssrLoadModule("/test/fixtures/sample.mdx");
    const html: string = await renderToString(content.default({}));
    expect(content.frontmatter).toEqual({ title: "見本" });
    expect(html).toContain('<h2 id="見出し">見出し</h2>');
    expect(html).toContain(
      '<p>本文の <strong>強調</strong> 注<br>改行 <img src="/a.png" alt="図" title="画像"></p>',
    );
    expect(html).toContain('<aside title="注記" data-kind="note" open><p>中身</p></aside>');
    expect(html).toContain(
      '<table><thead><tr><th style="text-align: left">a</th><th>b</th></tr></thead><tbody><tr><td style="text-align: left">1</td><td>2</td></tr></tbody></table>',
    );
    expect(html).toContain('<ol start="3"><li>三</li><li>四</li></ol>');
    expect(html).toContain(
      '<ul><li><input type="checkbox" disabled> 未完了</li><li><input type="checkbox" checked disabled> 完了</li></ul>',
    );
    expect(html).toMatch(/<div [^>]*data-lang="ts"[^>]*><pre class="shiki [^"]*"[^>]*><code>/);
    expect(html).toContain('<span style="--shiki-light:#D73A49;--shiki-dark:#F97583">const</span>');
  });
});
