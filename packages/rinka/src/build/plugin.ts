import { existsSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { getRequestListener } from "@hono/node-server";
import { isRunnableDevEnvironment, type Environment, type Plugin, type ViteDevServer } from "vite";

import { tagFromPath } from "../shared/names.ts";
import { transformSource, type Lang, type SourceResult } from "./compiler.ts";
import { entries, oxc } from "./entries.ts";
import { transformJsx } from "./jsx.ts";

/** rinka のプラグインの設定を表す。 */
export interface RinkaOptions {
  /** 要素のタグ名の接頭辞である。デフォルトは `rinka` である。 */
  readonly prefix?: string;
  /** 要素を置くディレクトリである。プロジェクトのルートからの相対パスで記述し、デフォルトは `src/elements` である。 */
  readonly elementsDir?: string;
}

/** 環境ごとの実行時のコードの入口を、`lib/` からの相対パスで表す。 */
const runtimes: Readonly<Record<"client" | "server", Readonly<Record<string, string>>>> = {
  client: {
    [entries.main]: "client/index.js",
    [entries.jsxRuntime]: "client/jsx-runtime.js",
    [entries.internal]: "client/internal.js",
  },
  server: {
    [entries.main]: "server/index.js",
    [entries.jsxRuntime]: "server/jsx-runtime.js",
    [entries.internal]: "server/internal.js",
  },
};

/** 拡張子ごとの、変換する言語である。 */
const langs: Readonly<Record<string, Lang>> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
};

/** rinka のプラグインの名前である。 */
const NAME = "rinka";

/** ルートの表を export する仮想モジュールの ID である。 */
const ROUTES = `\0${entries.routes}`;

/** 開発中のページの `<head>` に出力する、Vite のクライアントを読み込むスクリプトである。 */
const VITE_CLIENT = '<script type="module" src="/@vite/client"></script>';

/** `ssr` の環境で読み込んだ `rinka/internal` の、アプリを作成する関数を表す。 */
interface InternalModule {
  readonly createApp: (
    routes: unknown,
    options: { readonly head: string; readonly onError: (error: unknown) => Response },
  ) => { readonly fetch: (request: Request) => Response | Promise<Response> };
}

/** 変換するプロジェクトのファイルの、モジュールのパス、ルートからの相対パス、言語を表す。 */
interface ProjectFile {
  readonly path: string;
  readonly file: string;
  readonly lang: Lang;
}

/** 要素のファイルを変換した結果なら、登録の設定を JSON にした文字列を返す。 */
const signatureOf = (result: SourceResult): string | undefined =>
  result.element && JSON.stringify(result.element.options);

/** 環境がブラウザで実行する環境かどうかを返す。 */
const isClient = (environment: Environment): boolean => environment.config.consumer === "client";

/**
 * rinka の Vite プラグインを作成する。`rinka` の実行時のコードを環境ごとに解決し、
 * プロジェクトのモジュールにコンパイラの変換を適用する。
 */
export function rinka(options: RinkaOptions = {}): Plugin[] {
  const prefix = options.prefix ?? "rinka";
  let root = "";
  let elementsDir = "";

  /** モジュールの ID を、クエリの無いプロジェクトのファイルなら、ルートからの相対パスと言語にする。 */
  const projectFile = (id: string): ProjectFile | undefined => {
    const lang = langs[extname(id)];
    if (!lang || id.includes("?") || id.includes("/node_modules/") || id.startsWith("\0")) {
      return undefined;
    }
    const file = inside(root, id);
    return file === undefined ? undefined : { path: id, file, lang };
  };

  /** 要素のファイルなら、タグ名を返す。 */
  const tagOf = (path: string, lang: Lang): string | undefined => {
    if (lang !== "tsx" && lang !== "jsx") return undefined;
    const inner = inside(elementsDir, path);
    if (inner === undefined || inner.split("/").some((part) => part.startsWith("_"))) {
      return undefined;
    }
    return tagFromPath(prefix, inner);
  };

  /** クライアントの環境で変換した要素のファイルの、パスごとの登録の設定の JSON である。 */
  const signatures = new Map<string, string>();

  /** プロジェクトのファイルに、元のソースの変換を適用する。 */
  const compile = (code: string, target: ProjectFile, client: boolean): SourceResult => {
    const tag = tagOf(target.path, target.lang);
    return transformSource(code, {
      id: target.path,
      file: target.file,
      lang: target.lang,
      client,
      ...(tag !== undefined && { element: { tag } }),
    });
  };

  return [
    {
      name: NAME,
      enforce: "pre",
      config: () => ({ appType: "custom", oxc }),
      configEnvironment(name, config) {
        const consumer = config.consumer ?? (name === "client" ? "client" : "server");
        return consumer === "server" ? { resolve: { noExternal: [entries.main] } } : null;
      },
      configResolved(config) {
        if (config.plugins.filter((plugin) => plugin.name === NAME).length > 1) {
          throw new Error(
            "rinka のプラグインが 2 つ以上登録されています。vite.config.ts の plugins に rinka() を 1 回だけ記述してください。",
          );
        }
        root = config.root;
        elementsDir = resolve(root, options.elementsDir ?? "src/elements");
      },
      buildStart() {
        checkTags(elementsDir, tagOf);
      },
      resolveId(id) {
        if (id === entries.routes) return ROUTES;
        const entry = runtimes[isClient(this.environment) ? "client" : "server"][id];
        return entry === undefined ? null : fileURLToPath(new URL(`../${entry}`, import.meta.url));
      },
      load(id) {
        return id === ROUTES ? routesModule(resolve(root, "src/routes"), root) : null;
      },
      configureServer(server) {
        return () => {
          server.middlewares.use(appMiddleware(server));
        };
      },
      async hotUpdate({ file, read }) {
        const previous = signatures.get(file);
        const target = projectFile(file);
        if (previous === undefined || !target || !isClient(this.environment)) return undefined;
        let next: string | undefined;
        try {
          next = signatureOf(compile(await read(), target, true));
        } catch {
          return undefined;
        }
        if (next === previous) return undefined;
        this.environment.hot.send({ type: "full-reload" });
        return [];
      },
      transform(code, id) {
        const target = projectFile(id);
        if (!target) return null;
        const client = isClient(this.environment);
        const result = compile(code, target, client);
        const signature = signatureOf(result);
        if (client && signature !== undefined) signatures.set(target.path, signature);
        return { code: result.code, map: result.map };
      },
    },
    {
      name: `${NAME}:jsx`,
      transform(code, id) {
        const target = projectFile(id);
        if (target?.lang !== "tsx" && target?.lang !== "jsx") return null;
        const result = transformJsx(code, { id: target.path, file: target.file });
        return { code: result.code, map: result.map };
      },
    },
  ];
}

/** `path` が `dir` の中にあれば、`dir` からの `/` で区切った相対パスを返す。 */
function inside(dir: string, path: string): string | undefined {
  const inner = relative(dir, path);
  return isAbsolute(inner) || inner === ".." || inner.startsWith(`..${sep}`)
    ? undefined
    : inner.split(sep).join("/");
}

/** `dir` の中の要素のファイルを走査し、2 つのファイルが同じタグになればエラーにする。 */
function checkTags(dir: string, tagOf: (path: string, lang: Lang) => string | undefined): void {
  if (!existsSync(dir)) return;
  const owners = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const path = join(dir, entry);
    const lang = langs[extname(path)];
    if (!lang) continue;
    const tag = tagOf(path, lang);
    if (tag === undefined) continue;
    const file = entry.split(sep).join("/");
    const other = owners.get(tag);
    if (other !== undefined) {
      throw new Error(
        `要素のファイル ${other} と ${file} は、どちらもタグ名 ${tag} になります。どちらかのファイル名を変更してください。`,
      );
    }
    owners.set(tag, file);
  }
}

/**
 * `dir` を走査し、`page.tsx` を静的なパスに対応させるルートの表を export するモジュールのコードを返す。
 * 名前が `[` か `(` で始まるディレクトリは走査しない。
 */
function routesModule(dir: string, root: string): string {
  const routes: string[] = [];
  const visit = (current: string, segments: readonly string[]): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith("[") && !entry.name.startsWith("(")) {
          visit(join(current, entry.name), [...segments, entry.name]);
        }
      } else if (entry.name === "page.tsx") {
        const path = `/${segments.join("/")}`;
        const module = `/${relative(root, join(current, entry.name)).split(sep).join("/")}`;
        routes.push(
          `{ path: ${JSON.stringify(path)}, page: () => import(${JSON.stringify(module)}) }`,
        );
      }
    }
  };
  if (existsSync(dir)) visit(dir, []);
  return `export const routes = [\n${routes.join(",\n")}\n];\n`;
}

/**
 * `ssr` の環境のランナーで読み込んだ `rinka/routes` からアプリを作成し、リクエストを渡すミドルウェアを返す。
 * アプリはリクエストごとに作成する。ページの読み込みか描画で投げたエラーは `next` に渡す。
 */
function appMiddleware(
  server: ViteDevServer,
): (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void {
  return (request, response, next) => {
    const environment = server.environments.ssr;
    if (!environment || !isRunnableDevEnvironment(environment)) {
      next();
      return;
    }
    const { runner } = environment;
    (async () => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const { routes } = (await runner.import(entries.routes)) as { readonly routes: unknown };
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const { createApp } = (await runner.import(entries.internal)) as InternalModule;
      let failure: { readonly error: unknown } | undefined;
      const app = createApp(routes, {
        head: VITE_CLIENT,
        onError: (error) => {
          failure = { error };
          return new Response(null, { status: 500 });
        },
      });
      const listener = getRequestListener(
        async (incoming) => {
          const result = await app.fetch(incoming);
          if (failure) throw failure.error;
          return result;
        },
        {
          errorHandler: (error) => {
            next(error);
          },
        },
      );
      await listener(request, response);
    })().catch(next);
  };
}
