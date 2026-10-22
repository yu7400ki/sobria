import { fileURLToPath } from "node:url";

import { rinka } from "rinka/vite";
import { createServer, type RunnableDevEnvironment, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../fixtures/basic", import.meta.url));

let server: ViteDevServer;

beforeAll(async () => {
  server = await createServer({
    root,
    configFile: false,
    logLevel: "error",
    server: { middlewareMode: true, hmr: false },
    plugins: [rinka({ prefix: "app" })],
  });
});

afterAll(async () => {
  await server.close();
});

describe("Vite プラグイン", () => {
  it("ssr の環境で読み込んだページを描画すると、要素の DSD を出力する", async () => {
    const { runner } = server.environments.ssr as RunnableDevEnvironment;
    const { renderToString } = await runner.import("rinka/server");
    const { jsx } = await runner.import("rinka/jsx-runtime");
    const { default: Page } = await runner.import("/src/routes/page.tsx");
    const html: string = await renderToString(jsx(Page, {}));
    expect(html).toContain('<app-counter data-oh="h1"');
    expect(html).toContain('start="2"');
    expect(html).toContain("<button>clicks: 2</button><p>4</p><div><slot></slot></div>");
    expect(html).toContain("</template>body</app-counter>");
  });

  it("client の環境で変換した要素のモジュールは、要素を登録し、await を関門で包む", async () => {
    const result = await server.environments.client.transformRequest("/src/elements/counter.tsx");
    expect(result?.code).toContain('__rinka_defineElement("app-counter", Counter,');
    expect(result?.code).toContain("await __rinka_gate(Promise.resolve())");
    expect(result?.code).toContain('site: "src/elements/counter.tsx:');
  });

  it("rinka のプラグインを 2 回登録すると、エラーで停止する", async () => {
    await expect(
      createServer({
        root,
        configFile: false,
        logLevel: "silent",
        server: { middlewareMode: true, hmr: false },
        plugins: [rinka(), rinka()],
      }),
    ).rejects.toThrow(/2 つ以上/);
  });
});
