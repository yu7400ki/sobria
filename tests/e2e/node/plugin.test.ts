import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { rinka } from "rinka/vite";
import {
  createServer,
  type InlineConfig,
  type RunnableDevEnvironment,
  type ViteDevServer,
} from "vite";
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

describe("タグ名の検査", () => {
  it("2 つのファイルが同じタグになると、開発サーバーの起動時にエラーにする", async () => {
    const project = await mkdtemp(join(tmpdir(), "rinka-tags-"));
    try {
      await mkdir(join(project, "src/elements/forms"), { recursive: true });
      const source = "export default function X() { return <p />; }\n";
      await writeFile(join(project, "src/elements/forms/date-picker.tsx"), source);
      await writeFile(join(project, "src/elements/forms-date-picker.tsx"), source);
      const starting = createServer({
        root: project,
        configFile: false,
        logLevel: "silent",
        server: { middlewareMode: true, hmr: false },
        plugins: [rinka({ prefix: "app" })],
      });
      await expect(starting).rejects.toThrow(/app-forms-date-picker/);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

/** `files` を配置した一時的なプロジェクトで開発サーバーを起動し、`run` を実行する。 */
async function withProject(
  files: Readonly<Record<string, string>>,
  run: (server: ViteDevServer) => Promise<void>,
  config: InlineConfig = {},
): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), "rinka-plugin-"));
  try {
    await Promise.all(
      Object.entries(files).map(async ([file, source]) => {
        await mkdir(dirname(join(project, file)), { recursive: true });
        await writeFile(join(project, file), source);
      }),
    );
    const dev = await createServer({
      root: project,
      configFile: false,
      logLevel: "silent",
      server: { middlewareMode: true, hmr: false },
      plugins: [rinka({ prefix: "app" })],
      ...config,
    });
    try {
      await run(dev);
    } finally {
      await dev.close();
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

const card = `export default function Card(props: { a: string }) { return <p>{props.a}</p>; }
export const load = async () => { await 0; };
`;

describe("変換の対象", () => {
  it("import と export の無い JSX のモジュールも、ES モジュールとして変換する", async () => {
    await withProject({ "src/main.tsx": "console.log(<p>1</p>);\n" }, async (dev) => {
      const result = await dev.environments.client.transformRequest("/src/main.tsx");
      expect(result?.code).not.toContain("require(");
      expect(result?.code).toContain("import");
    });
  });

  it("クエリの付いた ID には、コンパイラの変換を適用しない", async () => {
    await withProject({ "src/elements/card.tsx": "export const raw = 1;\n" }, async (dev) => {
      const result = await dev.environments.client.transformRequest("/src/elements/card.tsx?raw");
      expect(result?.code).toContain("export const raw = 1;");
      expect(result?.code).not.toContain("__rinka_defineElement");
    });
  });

  it("consumer が client の環境は、名前に関わらずクライアント向けに変換する", async () => {
    await withProject(
      { "src/elements/card.tsx": card },
      async (dev) => {
        const widget = dev.environments.widget!;
        const result = await widget.transformRequest("/src/elements/card.tsx");
        expect(result?.code).toContain("__rinka_gate(0)");
        expect(result?.code).toContain("import.meta.hot");
        const resolved = await widget.pluginContainer.resolveId("rinka");
        expect(resolved?.id.split(sep).join("/")).toMatch(/\/lib\/client\/index\.js$/);
      },
      { environments: { widget: { consumer: "client" } } },
    );
  });
});
