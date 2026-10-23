import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { rinka } from "rinka/vite";
import {
  type HotPayload,
  type InlineConfig,
  type Plugin,
  type RunnableDevEnvironment,
  type ViteDevServer,
  mergeConfig,
} from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDevServer, originOf } from "../dev-server.ts";

const root = fileURLToPath(new URL("../fixtures/basic", import.meta.url));

let server: ViteDevServer;

beforeAll(async () => {
  server = await createDevServer(root, { server: { middlewareMode: true } });
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

  it("client の環境で変換した要素のモジュールは、要素を登録し、await する値を stopIfSeeding の戻り値に渡す", async () => {
    const result = await server.environments.client.transformRequest("/src/elements/counter.tsx");
    expect(result?.code).toContain('__rinka_defineElement("app-counter", Counter,');
    expect(result?.code).toContain("await __rinka_stop(Promise.resolve())");
    expect(result?.code).toContain('site: "src/elements/counter.tsx:');
  });

  it("変換したモジュールのソースマップは、モジュールのディレクトリからの相対パスで元のファイルを指す", async () => {
    for (const name of ["client", "ssr"] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const result = await server.environments[name].transformRequest("/src/elements/counter.tsx");
      expect(result?.map && "sources" in result.map ? result.map.sources : undefined).toEqual([
        "counter.tsx",
      ]);
    }
  });

  it("client の環境は、rinka のランタイムが動的に import する seroval を事前バンドルの対象にし、変換で新しい依存として発見しない", async () => {
    const client = server.environments.client;
    const codec = fileURLToPath(
      new URL("../node_modules/rinka/lib/client/wire-codec.js", import.meta.url),
    );
    await client.transformRequest(`/@fs/${realpathSync(codec).split(sep).join("/")}`);
    const metadata = client.depsOptimizer?.metadata;
    const deps = Object.keys({ ...metadata?.optimized, ...metadata?.discovered });
    expect(deps).toContain("rinka > seroval");
    expect(deps).not.toContain("seroval");
  });

  it("trustedOrigins に、オリジンでない値を記述するとエラーにする", () => {
    expect(() => rinka({ trustedOrigins: ["https://www.example.com"] })).not.toThrow();
    for (const origin of ["https://*.example.com", "https://www.example.com/", "www.example.com"]) {
      expect(() => rinka({ trustedOrigins: [origin] })).toThrow("trustedOrigins");
    }
  });

  it("rinka のプラグインを 2 回登録すると、エラーで停止する", async () => {
    // createDevServer が 1 つ目の rinka のプラグインを登録する
    await expect(
      createDevServer(root, { server: { middlewareMode: true }, plugins: [rinka()] }),
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
      const starting = createDevServer(project, { server: { middlewareMode: true } });
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
    const dev = await createDevServer(
      project,
      mergeConfig({ server: { middlewareMode: true } }, config),
    );
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
        expect(result?.code).toContain("__rinka_stop(0)");
        const resolved = await widget.pluginContainer.resolveId("rinka");
        expect(resolved?.id.split(sep).join("/")).toMatch(/\/lib\/client\/index\.js$/);
      },
      { environments: { widget: { consumer: "client" } } },
    );
  });
});

/** HMR のソケットで開発サーバーに接続する。`next` は、まだ読んでいない次のメッセージの種類を返す。カスタムイベントは、イベントの名前を返す。 */
async function connect(url: URL): Promise<{
  readonly socket: WebSocket;
  readonly next: () => Promise<string>;
}> {
  const socket = new WebSocket(url, "vite-hmr");
  const received: string[] = [];
  const waiting: ((type: string) => void)[] = [];
  let read = 0;
  const connected = new Promise<void>((resolve) => {
    socket.addEventListener("message", (message) => {
      const payload = JSON.parse(String(message.data)) as HotPayload;
      if (payload.type === "connected") return resolve();
      const type = payload.type === "custom" ? payload.event : payload.type;
      received.push(type);
      waiting.shift()?.(type);
    });
  });
  await connected;
  const next = () =>
    read < received.length
      ? Promise.resolve(received[read++]!)
      : new Promise<string>((resolve) => {
          read++;
          waiting.push(resolve);
        });
  return { socket, next };
}

/** 要素のファイルを書き換えて変更を通知し、client の環境が最初に送ったメッセージの種類を返す。 */
async function update(dev: ViteDevServer, source: string): Promise<string> {
  const client = dev.environments.client;
  await client.transformRequest("/src/elements/card.tsx");
  const send = client.hot.send.bind(client.hot);
  const sent = new Promise<string>((resolve) => {
    client.hot.send = (payload: HotPayload) => {
      resolve(payload.type);
      send(payload);
    };
  });
  const path = join(dev.config.root, "src/elements/card.tsx");
  await writeFile(path, source);
  dev.watcher.emit("change", path);
  return sent;
}

describe("開発中の HMR", () => {
  const options = { server: { hmr: true, ws: false as const } };

  it("クライアントがページの再読み込みを求めるイベントを送ると、そのクライアントにだけ full-reload を送る", async () => {
    // test:echo を送ったクライアントに、同じ名前のカスタムイベントを返す
    const echo: Plugin = {
      name: "echo",
      configureServer(dev) {
        dev.environments.client.hot.on("test:echo", (_data, client) => {
          client.send("test:echo", {});
        });
      },
    };
    const dev = await createDevServer(root, { server: { port: 0, hmr: true }, plugins: [echo] });
    try {
      await dev.listen();
      const url = new URL(originOf(dev).replace("http", "ws"));
      const [first, second] = await Promise.all([connect(url), connect(url)]);
      first.socket.send(JSON.stringify({ type: "custom", event: "rinka:reload" }));
      expect(await first.next()).toBe("full-reload");
      // full-reload が全体に送られていれば、後のクライアントには test:echo より先に full-reload が届く
      second.socket.send(JSON.stringify({ type: "custom", event: "test:echo" }));
      expect(await second.next()).toBe("test:echo");
      first.socket.close();
      second.socket.close();
    } finally {
      await dev.close();
    }
  });

  it("要素の props の構成が変わらなければ、モジュールを更新する", async () => {
    await withProject(
      { "src/elements/card.tsx": card },
      async (dev) => {
        expect(await update(dev, card.replace("<p>", "<p>!"))).toBe("update");
      },
      options,
    );
  });
});
