import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { rinka, type RinkaApi } from "rinka/vite";
import {
  type HotPayload,
  type InlineConfig,
  type Plugin,
  type RunnableDevEnvironment,
  type ViteDevServer,
  mergeConfig,
} from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDevServer, originOf, type RinkaSetup } from "../dev-server.ts";

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
    expect(html).toContain(
      "<button><!---->clicks<!---->: <!---->2<!----></button><p><!---->4<!----></p><div><slot></slot></div>",
    );
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

  it("extensions に、登録できない拡張子を記述するとエラーにする", () => {
    expect(() => rinka({ extensions: [".mdx", ".page"] })).not.toThrow();
    for (const extensions of [
      ["mdx"],
      ["."],
      [".page.md"],
      [".m-dx"],
      [".tsx"],
      [".js"],
      [".mts"],
      [".json"],
      [".css"],
      [".mdx", ".mdx"],
    ]) {
      expect(() => rinka({ extensions })).toThrow("extensions");
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
  setup: RinkaSetup = {},
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
      setup,
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

describe("サーバー関数を定義できる範囲", () => {
  it("src/ の外のファイルでサーバー関数を定義すると、サーバー向けとクライアント向けの変換をエラーにする", async () => {
    await withProject(
      {
        "test/fns.ts":
          'import { defineServerFn } from "rinka/server";\nexport const f = defineServerFn(() => 1);\n',
      },
      async (dev) => {
        await expect(dev.environments.ssr.transformRequest("/test/fns.ts")).rejects.toThrow(
          /src\/ の中のファイルで定義してください/,
        );
        await expect(dev.environments.client.transformRequest("/test/fns.ts")).rejects.toThrow(
          /src\/ の中のファイルで定義してください/,
        );
      },
    );
  });

  it("ライブラリのソースでサーバー関数を定義すると、ライブラリでは定義できないことを示すエラーにする", async () => {
    await withProject(
      {
        "package.json": JSON.stringify({ dependencies: { "acme-lib": "1.0.0" } }),
        "node_modules/acme-lib/package.json": JSON.stringify({
          name: "acme-lib",
          rinka: { prefix: "acme", elements: "src/elements" },
        }),
        "node_modules/acme-lib/src/fns.ts":
          'import { defineServerFn } from "rinka/server";\nexport const f = defineServerFn(() => 1);\n',
      },
      async (dev) => {
        await expect(
          dev.environments.ssr.transformRequest("/node_modules/acme-lib/src/fns.ts"),
        ).rejects.toThrow(/ライブラリでは定義できません/);
      },
    );
  });
});

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

  it("client の環境で rinka/server を参照するファイルは、参照したファイルを示すエラーにする", async () => {
    await withProject(
      {
        "src/lib/value.ts":
          'import { redirect } from "rinka/server";\nexport const go = () => redirect("/");\n',
        "src/lib/side.ts": 'import "rinka/server";\n',
        "src/lib/dynamic.ts": 'export const load = () => import("rinka/server");\n',
        "src/lib/fns.ts":
          'import { defineServerFn, type ServerFn } from "rinka/server";\nexport const a: ServerFn<undefined, number> = defineServerFn(() => 1);\n',
      },
      async (dev) => {
        const client = dev.environments.client;
        const results = await Promise.all(
          ["value", "side", "dynamic", "fns"].map((name) =>
            client.transformRequest(`/src/lib/${name}.ts`).then(
              () => "ok",
              (error: unknown) => (error instanceof Error ? error.message : String(error)),
            ),
          ),
        );
        const message = ": クライアント向けのコードから rinka/server を参照しています。";
        expect(results).toEqual([
          expect.stringContaining(`src/lib/value.ts${message}`),
          expect.stringContaining(`src/lib/side.ts${message}`),
          expect.stringContaining(`src/lib/dynamic.ts${message}`),
          "ok",
        ]);
      },
    );
  });

  it("依存の事前走査では、client の環境の rinka/server の解決をエラーにしない", async () => {
    // Vite の依存の事前走査は、型に無い scan のオプションを付けて resolveId を呼ぶ
    const scan = { isEntry: false, scan: true };
    const scanned = await server.environments.client.pluginContainer.resolveId(
      "rinka/server",
      join(root, "src/lib/fns.ts"),
      scan,
    );
    expect(scanned).toMatchObject({ id: "rinka/server", external: true });
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

/** 拡張子が `.page` のファイルの先頭の行 `@page` を取り除いて、TSX のソースにするテスト用のプラグインを作成する。 */
const pagePlugin = (): Plugin => ({
  name: "test:page",
  transform: (code, id) => (id.endsWith(".page") ? code.replace(/^@page\n/, "") : null),
});

/** 拡張子が `.page` のファイルの内容である。コンポーネントのタグと、型注釈を含む。 */
const doc = `@page
import Card from "./card.tsx";
const n: number = 1;
export default function Doc() { return <Card n={n} />; }
`;

/** 開発サーバー `dev` の ssr の環境で `src/lib/doc.page` を変換したコードか、エラーのメッセージを返す。 */
const transformed = (dev: ViteDevServer) =>
  dev.environments.ssr.transformRequest("/src/lib/doc.page").then(
    (result) => result?.code ?? "",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe("登録した拡張子のファイル", () => {
  const options = { extensions: [".page"] };
  const files = {
    "src/lib/doc.page": doc,
    "src/lib/card.tsx":
      "export default function Card(props: { n: number }) { return <p>{props.n}</p>; }\n",
  };

  it("変換するプラグインを rinka より前に配置すると、enforce が無くても、ssr と client の環境で TSX としてコンパイルする", async () => {
    await withProject(
      {
        ...files,
        "src/routes/page.tsx":
          'import Doc from "../lib/doc.page";\nexport default function Page() { return <main><Doc /></main>; }\n',
      },
      async (dev) => {
        await dev.listen();
        const html = await (await fetch(originOf(dev))).text();
        expect(html).toContain("<main><p>1</p></main>");
        const client = await dev.environments.client.transformRequest("/src/lib/doc.page");
        expect(client?.code).toContain("get n()");
        expect(client?.code).toMatch(/_jsx\(Card, \{[^]*\}, void 0, "src\/lib\/doc\.page:3:\d+"\)/);
        expect(client?.code).not.toContain("number");
      },
      { server: { middlewareMode: false, port: 0 } },
      { options, before: [pagePlugin()] },
    );
  });

  it("enforce の無い変換するプラグインを rinka より後ろに配置すると、配置を直すことを求めるエラーにする", async () => {
    await withProject(
      files,
      async (dev) => expect(await transformed(dev)).toContain("rinka より前に配置してください"),
      { plugins: [pagePlugin()] },
      { options },
    );
  });

  it("登録した拡張子のページとレイアウトを描画し、開発中に追加したページをルートの表に加える", async () => {
    await withProject(
      {
        "src/routes/layout.page":
          "@page\nexport default function Layout(props: { children?: unknown }) { return <main>{props.children}</main>; }\n",
        "src/routes/page.page": "@page\nexport default function Page() { return <h1>home</h1>; }\n",
        // ページを追加するディレクトリを先に作成し、ファイルの追加だけでルートの表を作り直すことを確認する
        "src/routes/added/part.ts": "export const part = 1;\n",
      },
      async (dev) => {
        await dev.listen();
        const text = async (path: string) => (await fetch(originOf(dev) + path)).text();
        expect(await text("/")).toContain("<main><h1>home</h1></main>");
        await addFile(
          dev,
          "src/routes/added/page.page",
          "@page\nexport default function Added() { return <p>added</p>; }\n",
        );
        await vi.waitFor(async () => expect(await text("/added")).toContain("<p>added</p>"), {
          timeout: 10_000,
          interval: 200,
        });
        expect(await prepared(dev, "routes.d.ts")).toContain('"/added"');
      },
      { server: { middlewareMode: false, port: 0 } },
      { options, before: [pagePlugin()] },
    );
  }, 30_000);

  it("登録した拡張子のファイルでサーバー関数を定義すると、エラーにする", async () => {
    await withProject(
      {
        "src/lib/doc.page": `@page
import { defineServerFn } from "rinka/server";
export const a = defineServerFn(() => 1);
`,
      },
      async (dev) =>
        expect(await transformed(dev)).toContain("src/lib/doc.page: 登録した拡張子のファイルでは"),
      {},
      { options, before: [pagePlugin()] },
    );
  });
});

/** 開発サーバー `dev` が生成した `.rinka/` のファイルのうち、名前が `name` のファイルの内容を返す。 */
const prepared = (dev: ViteDevServer, name: string) =>
  readFile(join(dev.config.root, ".rinka", name), "utf8");

/** 開発サーバー `dev` のプロジェクトに、ルートからの相対パス `file` のファイルを追加し、追加を通知する。 */
async function addFile(dev: ViteDevServer, file: string, source: string): Promise<void> {
  const path = join(dev.config.root, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
  dev.watcher.emit("add", path);
}

/** 開発サーバー `dev` のプロジェクトから、ルートからの相対パス `file` のファイルを削除し、削除を通知する。 */
async function removeFile(dev: ViteDevServer, file: string): Promise<void> {
  const path = join(dev.config.root, file);
  await rm(path);
  dev.watcher.emit("unlink", path);
}

const page = "export default function Page() { return <p>page</p>; }\n";

describe(".rinka/ の生成", () => {
  it("tsconfig.base.json を追加すると、生成する tsconfig がそれを extends し、削除すると extends から取り除く", async () => {
    await withProject({ "src/routes/page.tsx": page }, async (dev) => {
      const extendsOf = async () =>
        (JSON.parse(await prepared(dev, "tsconfig.shared.json")) as { extends: string[] }).extends;
      await addFile(dev, "tsconfig.base.json", "{}\n");
      expect(await extendsOf()).toEqual(["rinka/tsconfig.json", "../tsconfig.base.json"]);
      await removeFile(dev, "tsconfig.base.json");
      expect(await extendsOf()).toEqual(["rinka/tsconfig.json"]);
    });
  });

  it("Vite の設定を解決する前に api の prepare を呼ぶと、エラーを投げる", () => {
    const api: RinkaApi = rinka()[0]?.api;
    expect(() => api.prepare()).toThrow(/設定を解決した後/);
  });

  it("開発サーバーを起動すると、.rinka/ に型宣言と tsconfig を生成する", async () => {
    await withProject(
      { "src/elements/card.tsx": card, "src/routes/users/[id]/page.tsx": page },
      async (dev) => {
        expect(await prepared(dev, "elements.d.ts")).toContain(
          '"app-card": ElementRef<typeof E0>;',
        );
        expect(await prepared(dev, "routes.d.ts")).toContain('"/users/[id]": { id: string };');
        expect(await prepared(dev, "env.d.ts")).toContain("type Element =");
        expect(JSON.parse(await prepared(dev, "tsconfig.elements.json"))).toMatchObject({
          extends: ["rinka/tsconfig.json"],
        });
      },
    );
  });

  it("要素のファイルを追加すると elements.d.ts にタグを加え、削除すると取り除く", async () => {
    await withProject({ "src/elements/card.tsx": card }, async (dev) => {
      await addFile(dev, "src/elements/badge.tsx", card);
      expect(await prepared(dev, "elements.d.ts")).toContain('"app-badge"');
      await removeFile(dev, "src/elements/badge.tsx");
      expect(await prepared(dev, "elements.d.ts")).not.toContain('"app-badge"');
    });
  });

  it("ページのファイルを追加すると routes.d.ts にルートを加え、削除すると取り除く", async () => {
    await withProject({ "src/routes/page.tsx": page }, async (dev) => {
      await addFile(dev, "src/routes/docs/[...slug]/page.tsx", page);
      expect(await prepared(dev, "routes.d.ts")).toContain('"/docs/[...slug]": { slug: string };');
      await removeFile(dev, "src/routes/docs/[...slug]/page.tsx");
      expect(await prepared(dev, "routes.d.ts")).not.toContain("/docs");
    });
  });

  it("ページを持つディレクトリの追加を通知すると routes.d.ts にルートを加え、削除を通知すると取り除く", async () => {
    await withProject({ "src/routes/page.tsx": page }, async (dev) => {
      const dir = join(dev.config.root, "src/routes/users/[id]");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "page.tsx"), page);
      dev.watcher.emit("addDir", dir);
      expect(await prepared(dev, "routes.d.ts")).toContain('"/users/[id]": { id: string };');
      await rm(dir, { recursive: true });
      dev.watcher.emit("unlinkDir", dir);
      expect(await prepared(dev, "routes.d.ts")).not.toContain("/users");
    });
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
