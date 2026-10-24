import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Environment, Plugin, RunnableDevEnvironment } from "vite";

import { reloadEvent } from "../shared/hmr.ts";
import type { CreateApp } from "../shared/routes.ts";
import { entries, serverImports, virtualId, virtualUrl } from "./entries.ts";
import { appCode, serverEntry, serverFnLoaderCode, type AppModuleOptions } from "./entry.ts";
import { fromApp } from "./package.ts";
import { inside } from "./paths.ts";
import { isPrepareInput } from "./prepare.ts";
import { routeStyles } from "./route-styles.ts";
import { ROUTES_DIR, routeFileNames } from "./routes.ts";
import { isServerFnSource } from "./server-fns.ts";
import { SERVER_ENTRY_NAME, isClient, type SceneContext } from "./settings.ts";

/** `rinka/styles` の仮想モジュールの ID の、ルートのファイルの一覧を表すクエリの前までである。 */
const STYLES = `${virtualId(entries.styles)}?files=`;

/** ランナーが動的に import して、`rinka/styles` の仮想モジュールを読み込む指定子の、クエリの前までである。 */
const STYLES_URL = `${virtualUrl(entries.styles)}?files=`;

/** 開発中のページの `<head>` に出力する、Vite のクライアントを読み込むスクリプトである。 */
const VITE_CLIENT = '<script type="module" src="/@vite/client"></script>';

/**
 * 開発中の `rinka/app` のコードを返す。アプリは、Vite のクライアントを読み込み、
 * サーバーコンポーネントの CSS の一覧を `rinka/styles` から読み込み、エラーを Vite のエラーのオーバーレイで表示する。
 */
export const devAppModule = ({ serverFns, trustedOrigins }: AppModuleOptions): string =>
  appCode(
    ["createApp", "serverFnLoader", "devErrorResponse"],
    [
      `  head: ${JSON.stringify(VITE_CLIENT)},`,
      `  styles: async (files) => (await import(${JSON.stringify(STYLES_URL)} + encodeURIComponent(JSON.stringify(files)))).default,`,
      "  onError: devErrorResponse,",
      `  loadServerFn: ${serverFnLoaderCode(serverFns)},`,
    ],
    trustedOrigins,
  );

/** 開発サーバーのプラグインを作成する関数が受け取る値を表す。 */
export interface ServeContext extends SceneContext {
  /** `.rinka/` を生成する。 */
  readonly writeTypes: () => void;
}

/** 開発サーバーと `vite preview` で、サーバーのエントリーにリクエストを渡すプラグインを返す。 */
export function serve({ settings, writeTypes }: ServeContext): Plugin {
  return {
    name: "rinka:serve",
    apply: "serve",
    config: (user) =>
      hasCloudflare(user.plugins ?? [])
        ? { environments: { ssr: { optimizeDeps: { include: serverImports.map(fromApp) } } } }
        : null,
    configurePreviewServer(server) {
      return () => {
        const { serverDir, clientDir } = settings();
        const entry = pathToFileURL(join(serverDir, `${SERVER_ENTRY_NAME}.js`)).href;
        // 本番の Node のサーバーと同じく、書き出したページをサーバーのエントリーより先に返す
        const statics = new Hono().use(serveStatic({ root: clientDir }));
        const load = async (): Promise<ServerModule> => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const { default: app } = (await import(entry)) as ServerModule;
          return {
            default: {
              fetch: async (request) => {
                const found = await statics.fetch(request);
                return found.status === 404 ? app.fetch(request) : found;
              },
            },
          };
        };
        server.middlewares.use(entryMiddleware(load, { forwardErrors: false }));
      };
    },
    resolveId: (id) => (id.startsWith(STYLES) ? id : null),
    async load(id) {
      if (!id.startsWith(STYLES) || isClient(this.environment)) return null;
      if (!("moduleGraph" in this.environment)) return null;
      const { moduleGraph } = this.environment;
      const files: unknown = JSON.parse(decodeURIComponent(id.slice(STYLES.length)));
      if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) {
        throw new TypeError(
          `[rinka] ${entries.styles} のクエリには、ルートのファイルの一覧を指定してください。`,
        );
      }
      const nodes = await Promise.all(files.map((file) => moduleGraph.getModuleByUrl(`/${file}`)));
      const links = routeStyles(nodes.filter((node) => node !== undefined));
      return `export default ${JSON.stringify(links)};\n`;
    },
    configureServer(server) {
      const { root, elementsDir } = settings();
      const routesDir = resolve(root, ROUTES_DIR);
      /** すべての環境のモジュールのグラフで、仮想モジュール `specifier` を無効にする。 */
      const invalidate = (specifier: string): void => {
        for (const environment of Object.values(server.environments)) {
          const node = environment.moduleGraph.getModuleById(virtualId(specifier));
          if (node) environment.moduleGraph.invalidateModule(node);
        }
      };
      /**
       * ファイル `path` が追加、変更、削除されたら、すべての環境の `rinka/styles` を無効にし、
       * サーバー関数を定義できるファイルなら `rinka/app` も無効にする。
       */
      const onSource = (path: string): void => {
        for (const environment of Object.values(server.environments)) {
          for (const [id, node] of environment.moduleGraph.idToModuleMap) {
            if (id.startsWith(STYLES)) environment.moduleGraph.invalidateModule(node);
          }
        }
        const file = inside(root, path);
        if (file !== undefined && isServerFnSource(file)) invalidate(entries.app);
      };
      const rewriteTypes = (): void => {
        try {
          writeTypes();
        } catch (error) {
          server.config.logger.error(error instanceof Error ? error.message : String(error));
        }
      };
      const onFile = (path: string): void => {
        if (inside(routesDir, path) !== undefined && routeFileNames.has(basename(path))) {
          invalidate(entries.routes);
        }
        if (isPrepareInput(root, elementsDir, path)) rewriteTypes();
        onSource(path);
      };
      const onDir = (path: string): void => {
        if (inside(routesDir, path) !== undefined) invalidate(entries.routes);
        if (isPrepareInput(root, elementsDir, path)) rewriteTypes();
      };
      server.watcher.on("add", onFile);
      server.watcher.on("unlink", onFile);
      server.watcher.on("change", onSource);
      server.watcher.on("addDir", onDir);
      server.watcher.on("unlinkDir", onDir);
      for (const environment of Object.values(server.environments)) {
        if (!isClient(environment)) continue;
        environment.hot.on(reloadEvent, (_data, client) => {
          client.send({ type: "full-reload" });
        });
      }
      return () => {
        const file = serverEntry(root);
        const entry = file === undefined ? entries.app : `/${file}`;
        server.middlewares.use(
          entryMiddleware(
            async () => {
              const ssr = server.environments.ssr;
              return ssr && isRunnable(ssr) ? ssr.runner.import<ServerModule>(entry) : undefined;
            },
            { forwardErrors: true },
          ),
        );
      };
    },
  };
}

/** Vite の設定の `plugins` に、入れ子の配列の中も含めて、Cloudflare のプラグインがあるかどうかを返す。 */
const hasCloudflare = (plugins: readonly unknown[]): boolean =>
  plugins.some((plugin) =>
    Array.isArray(plugin)
      ? hasCloudflare(plugin)
      : typeof plugin === "object" &&
        plugin !== null &&
        "name" in plugin &&
        typeof plugin.name === "string" &&
        plugin.name.startsWith("vite-plugin-cloudflare"),
  );

/** サーバーのエントリーのモジュールを表す。 */
interface ServerModule {
  readonly default: ReturnType<CreateApp>;
}

/**
 * `load` が返すサーバーのエントリーの default export の `fetch` に、リクエストを渡すミドルウェアを返す。
 * `fetch` が投げたエラーは、`forwardErrors` が真なら `next` に渡し、偽なら本文の無い 500 の Response にする。
 * `load` が投げたエラーは `next` に渡し、`load` が undefined を返せば、リクエストを `next` に渡す。
 */
function entryMiddleware(
  load: () => Promise<ServerModule | undefined>,
  { forwardErrors }: { readonly forwardErrors: boolean },
): (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void {
  return (request, response, next) => {
    (async () => {
      const entry = await load();
      if (entry === undefined) {
        next();
        return;
      }
      await getRequestListener(
        async (incoming) => {
          const result = await entry.default.fetch(incoming);
          response.statusCode = result.status;
          return result;
        },
        forwardErrors
          ? {
              errorHandler: (error) => {
                next(error);
              },
            }
          : {},
      )(request, response);
    })().catch(next);
  };
}

/**
 * `environment` がモジュールを実行できる開発の環境かどうかを返す。
 * クラスで判定せずに、`runner` の有無で判定する。
 */
const isRunnable = (environment: Environment): environment is RunnableDevEnvironment =>
  "runner" in environment;
