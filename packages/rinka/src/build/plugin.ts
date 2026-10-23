import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getRequestListener } from "@hono/node-server";
import {
  type Environment,
  type Plugin,
  type ResolvedConfig,
  type RunnableDevEnvironment,
  type ViteDevServer,
} from "vite";

import { reloadEvent } from "../shared/hmr.ts";
import type { CreateApp, Routes } from "../shared/routes.ts";
import { fileOfServerFnId } from "../shared/server-fn.ts";
import type { Lang } from "./ast.ts";
import { transformSource } from "./compiler.ts";
import { elementTag } from "./elements.ts";
import { entries, oxc, runtimes } from "./entries.ts";
import { transformJsx } from "./jsx.ts";
import { devPath, directUrl, inside } from "./paths.ts";
import { preparedFiles, writePrepared } from "./prepare.ts";
import { routeStyles } from "./route-styles.ts";
import { PAGE_FILE, ROUTES_DIR, routeFileNames, routesModule } from "./routes.ts";
import { SHEET_QUERY, clientSheetModule, serverSheetModule, sheetId, sheetPath } from "./sheets.ts";

/** rinka のプラグインの設定を表す。 */
export interface RinkaOptions {
  /** 要素のタグ名の接頭辞である。デフォルトは `rinka` である。 */
  readonly prefix?: string;
  /** 要素を置くディレクトリである。プロジェクトのルートからの相対パスで記述し、デフォルトは `src/elements` である。 */
  readonly elementsDir?: string;
  /** GET 以外のサーバー関数のリクエストで、別のサイトからでも受け付けるオリジンを、スキーム、ホスト、ポートを含めて列挙する。 */
  readonly trustedOrigins?: readonly string[];
  /** `false` なら、`.rinka/env.d.ts` でグローバルの `JSX` を宣言しない。 */
  readonly globalJSX?: false;
}

/** rinka のプラグインが、ほかのプラグインと CLI に公開する API を表す。 */
export interface RinkaApi {
  /** `.rinka/` を生成する。Vite の設定を解決する前に呼び出すと、エラーを投げる。 */
  readonly prepare: () => void;
}

/** 解決した Vite の設定 `config` に登録された rinka のプラグインの API を返す。登録されていなければ undefined を返す。 */
export function rinkaApi(config: ResolvedConfig): RinkaApi | undefined {
  const plugin = config.plugins.find((candidate) => candidate.name === NAME);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return plugin?.api as RinkaApi | undefined;
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
  const writeTypes = (): void => {
    if (root === "") {
      throw new Error("[rinka] .rinka/ は、Vite の設定を解決した後に生成してください。");
    }
    writePrepared(
      root,
      preparedFiles({ root, prefix, elementsDir, globalJSX: options.globalJSX ?? true }),
    );
  };
  const api: RinkaApi = { prepare: writeTypes };

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
    const file = fileOfServerFnId(id);
    if (file === undefined) return false;
    if (projectFile(`${root}/${file}`)?.file !== file || !existsSync(resolve(root, file))) {
      return false;
    }
    await environment.transformRequest(`/${file}`);
    if (!serverFnIds.get(file)?.has(id)) return false;
    await environment.runner.import(`/${file}`);
    return true;
  };

  return [
    {
      name: NAME,
      enforce: "pre",
      api,
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
        writeTypes();
      },
      resolveId(id, importer, resolveOptions) {
        if (id === entries.routes) return ROUTES;
        if (id.endsWith(SHEET_QUERY)) {
          return this.resolve(id.slice(0, -SHEET_QUERY.length), importer, { skipSelf: true }).then(
            (resolved) => resolved && sheetId(resolved.id),
          );
        }
        if (id === entries.server && isClient(this.environment)) {
          if ("scan" in resolveOptions && resolveOptions.scan === true)
            return { id, external: true };
          const from = importer === undefined ? undefined : (inside(root, importer) ?? importer);
          throw new Error(
            `${from ?? "(不明なファイル)"}: クライアント向けのコードから ${entries.server} を参照しています。${entries.server} の値は、サーバー関数とミドルウェアの定義の式の中でだけ使用できます。型だけを使用する名前は、import type か export type で記述してください。`,
          );
        }
        const entry = runtimes[isClient(this.environment) ? "client" : "server"][id];
        return entry === undefined ? null : fileURLToPath(new URL(`../${entry}`, import.meta.url));
      },
      load(id) {
        if (id === ROUTES) return routesModule(root, ROUTES_DIR);
        const sheet = sheetPath(id);
        if (sheet === undefined) return null;
        const path = devPath(sheet, root);
        return isClient(this.environment)
          ? clientSheetModule(`${path}?inline`)
          : serverSheetModule(`${path}?inline`, directUrl(path));
      },
      configureServer(server) {
        const routesDir = resolve(root, ROUTES_DIR);
        const invalidateRoutes = (): void => {
          for (const environment of Object.values(server.environments)) {
            const node = environment.moduleGraph.getModuleById(ROUTES);
            if (node) environment.moduleGraph.invalidateModule(node);
          }
        };
        const rewriteTypes = (): void => {
          try {
            writeTypes();
          } catch (error) {
            server.config.logger.error(error instanceof Error ? error.message : String(error));
          }
        };
        const baseConfig = resolve(root, "tsconfig.base.json");
        const onFile = (path: string): void => {
          if (inside(routesDir, path) !== undefined && routeFileNames.has(basename(path))) {
            invalidateRoutes();
            if (basename(path) === PAGE_FILE) rewriteTypes();
          }
          if (elementTag(prefix, elementsDir, path) !== undefined || resolve(path) === baseConfig) {
            rewriteTypes();
          }
        };
        const onDir = (path: string): void => {
          if (inside(routesDir, path) !== undefined) {
            invalidateRoutes();
            rewriteTypes();
          }
          if (inside(elementsDir, path) !== undefined) rewriteTypes();
        };
        server.watcher.on("add", onFile);
        server.watcher.on("unlink", onFile);
        server.watcher.on("addDir", onDir);
        server.watcher.on("unlinkDir", onDir);
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
        const tag = elementTag(prefix, elementsDir, target.path);
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
    if (!environment || !isRunnable(environment)) {
      next();
      return;
    }
    const { runner } = environment;
    (async () => {
      const routes = await runner.import<Routes>(entries.routes);
      const { createApp } = await runner.import<{ readonly createApp: CreateApp }>(
        entries.internal,
      );
      let failure: { readonly error: unknown } | undefined;
      const app = createApp(routes, {
        head: VITE_CLIENT,
        styles: async (files) => {
          const nodes = await Promise.all(
            files.map((file) => environment.moduleGraph.getModuleByUrl(`/${file}`)),
          );
          return routeStyles(nodes.filter((node) => node !== undefined));
        },
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

/**
 * `environment` がモジュールを実行できる開発の環境かどうかを返す。
 * クラスで判定せずに、`runner` の有無で判定する。
 */
const isRunnable = (environment: Environment): environment is RunnableDevEnvironment =>
  "runner" in environment;
