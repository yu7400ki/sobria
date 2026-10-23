import { existsSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { getRequestListener } from "@hono/node-server";
import {
  isRunnableDevEnvironment,
  type Environment,
  type Plugin,
  type RunnableDevEnvironment,
  type ViteDevServer,
} from "vite";

import { reloadEvent } from "../shared/hmr.ts";
import { tagFromPath } from "../shared/names.ts";
import type { CreateApp, Route } from "../shared/routes.ts";
import type { Lang } from "./ast.ts";
import { transformSource } from "./compiler.ts";
import { entries, oxc, runtimes } from "./entries.ts";
import { transformJsx } from "./jsx.ts";

/** rinka のプラグインの設定を表す。 */
export interface RinkaOptions {
  /** 要素のタグ名の接頭辞である。デフォルトは `rinka` である。 */
  readonly prefix?: string;
  /** 要素を置くディレクトリである。プロジェクトのルートからの相対パスで記述し、デフォルトは `src/elements` である。 */
  readonly elementsDir?: string;
  /** GET 以外のサーバー関数のリクエストで、別のサイトからでも受け付けるオリジンを、スキーム、ホスト、ポートを含めて列挙する。 */
  readonly trustedOrigins?: readonly string[];
}

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

/** 変換するプロジェクトのファイルの、モジュールのパス、ルートからの相対パス、言語を表す。 */
interface ProjectFile {
  readonly path: string;
  readonly file: string;
  readonly lang: Lang;
}

/** 環境がブラウザで実行する環境かどうかを返す。 */
const isClient = (environment: Environment): boolean => environment.config.consumer === "client";

/**
 * rinka の Vite プラグインを作成する。`rinka` の実行時のコードを環境ごとに解決し、
 * プロジェクトのモジュールにコンパイラの変換を適用する。
 */
export function rinka(options: RinkaOptions = {}): Plugin[] {
  const prefix = options.prefix ?? "rinka";
  const trustedOrigins = options.trustedOrigins ?? [];
  for (const origin of trustedOrigins) checkOrigin(origin);
  /** サーバーの環境で最後に変換したときに、サーバー関数を定義していたファイルの、ルートからの相対パスごとの ID の集合である。 */
  const serverFnIds = new Map<string, ReadonlySet<string>>();
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

  /**
   * ID のサーバー関数を今のソースで定義していれば、`environment` のランナーでそのファイルを読み込んで真を返す。
   * ID のファイルの部分がプロジェクトのファイルなら、`environment` で変換して最新の定義を確認する。`#` を含まない ID には偽を返す。
   */
  const loadServerFn = async (environment: RunnableDevEnvironment, id: string) => {
    const separator = id.lastIndexOf("#");
    if (separator === -1) return false;
    const file = id.slice(0, separator);
    if (projectFile(`${root}/${file}`)?.file !== file || !existsSync(resolve(root, file))) {
      return false;
    }
    await environment.transformRequest(`/${file}`);
    if (!serverFnIds.get(file)?.has(id)) return false;
    await environment.runner.import(`/${file}`);
    return true;
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

  return [
    {
      name: NAME,
      enforce: "pre",
      config: () => ({
        appType: "custom",
        oxc,
        optimizeDeps: {
          include: [`${entries.main} > @solidjs/signals`, `${entries.main} > seroval`],
        },
      }),
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
        for (const environment of Object.values(server.environments)) {
          if (!isClient(environment)) continue;
          environment.hot.on(reloadEvent, (_data, client) => {
            client.send({ type: "full-reload" });
          });
        }
        return () => {
          server.middlewares.use(appMiddleware(server, trustedOrigins, loadServerFn));
        };
      },
      transform(code, id) {
        const target = projectFile(id);
        if (!target) return null;
        const tag = tagOf(target.path, target.lang);
        const result = transformSource(code, {
          id: target.path,
          file: target.file,
          lang: target.lang,
          client: isClient(this.environment),
          ...(tag !== undefined && { element: { tag, module: `/${target.file}` } }),
        });
        if (!isClient(this.environment)) {
          if (result.serverFns.length > 0) serverFnIds.set(target.file, new Set(result.serverFns));
          else serverFnIds.delete(target.file);
        }
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
 * アプリはリクエストごとに作成する。アプリの onError が受け取ったエラーは `next` に渡す。
 * サーバー関数の ID は、`loadServerFn` に `ssr` の環境とともに渡す。
 */
function appMiddleware(
  server: ViteDevServer,
  trustedOrigins: readonly string[],
  loadServerFn: (environment: RunnableDevEnvironment, id: string) => Promise<boolean>,
): (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void {
  return (request, response, next) => {
    const environment = server.environments.ssr;
    if (!environment || !isRunnableDevEnvironment(environment)) {
      next();
      return;
    }
    const { runner } = environment;
    (async () => {
      const { routes } = await runner.import<{ readonly routes: readonly Route[] }>(entries.routes);
      const { createApp } = await runner.import<{ readonly createApp: CreateApp }>(
        entries.internal,
      );
      let failure: { readonly error: unknown } | undefined;
      const app = createApp(routes, {
        head: VITE_CLIENT,
        trustedOrigins,
        loadServerFn: (id) => loadServerFn(environment, id),
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

/** `origin` が、スキーム、ホスト、ポートだけのオリジンでなければ、エラーを投げる。 */
function checkOrigin(origin: string): void {
  let parsed: string | undefined;
  try {
    parsed = new URL(origin).origin;
  } catch {
    parsed = undefined;
  }
  if (parsed !== origin || origin.includes("*")) {
    throw new Error(
      `trustedOrigins の ${JSON.stringify(origin)} は、"https://www.example.com" のように、スキーム、ホスト、ポートだけのオリジンで記述してください。ワイルドカードは使用できません。`,
    );
  }
}
