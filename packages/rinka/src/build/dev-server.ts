import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { getRequestListener } from "@hono/node-server";
import type { Environment, Plugin, RunnableDevEnvironment } from "vite";

import { reloadEvent } from "../shared/hmr.ts";
import type { AppOptions, CreateApp } from "../shared/routes.ts";
import { moduleOfServerFnId } from "../shared/server-fn.ts";
import { entries, serverImports, virtualId } from "./entries.ts";
import { appCode, serverEntry, serverFnLoaderCode, type AppModuleOptions } from "./entry.ts";
import { fromApp } from "./package.ts";
import { inside } from "./paths.ts";
import { isPrepareInput } from "./prepare.ts";
import { routeStyles } from "./route-styles.ts";
import { ROUTES_DIR, routeFileNames } from "./routes.ts";
import { isServerFnSource } from "./server-fns.ts";
import { isClient, type Settings } from "./settings.ts";

/** 開発サーバーが Vite のプロセスで実行し、`rinka/app` が使用する関数を表す。 */
type DevHooks = Required<Pick<AppOptions, "styles" | "onError" | "loadServerFn">>;

/** 開発中の `rinka/app` が、プラグインのインスタンスの ID ごとの `DevHooks` を探す、グローバルの Map のキーである。 */
const DEV_HOOKS = "rinka.dev";

/** プラグインのインスタンスの ID ごとの `DevHooks` を保持する、グローバルの Map を返す。 */
function devHooks(): Map<string, DevHooks> {
  const global = globalThis as { [key: symbol]: Map<string, DevHooks> | undefined };
  return (global[Symbol.for(DEV_HOOKS)] ??= new Map<string, DevHooks>());
}

/** 開発中のページの `<head>` に出力する、Vite のクライアントを読み込むスクリプトである。 */
const VITE_CLIENT = '<script type="module" src="/@vite/client"></script>';

/**
 * 開発中の `rinka/app` のコードを返す。アプリは、Vite のクライアントを読み込み、
 * ID が `devId` の `DevHooks` があればそれを使用する。
 */
export const devAppModule = (
  { serverFns, trustedOrigins }: AppModuleOptions,
  devId: string,
): string =>
  appCode(
    [
      `  head: ${JSON.stringify(VITE_CLIENT)},`,
      "  styles: hooks?.styles,",
      "  onError: hooks?.onError,",
      `  loadServerFn: hooks?.loadServerFn ?? ${serverFnLoaderCode(serverFns)},`,
    ],
    trustedOrigins,
    [
      `const hooks = globalThis[Symbol.for(${JSON.stringify(DEV_HOOKS)})]?.get(${JSON.stringify(devId)});`,
      "",
    ],
  );

/** 開発サーバーのプラグインが、`rinka` のプラグインと共有する値を表す。 */
export interface ServeContext {
  /** `rinka` のプラグインの `config` で求めた設定を返す。 */
  readonly settings: () => Settings;
  /** `.rinka/` を生成する。 */
  readonly writeTypes: () => void;
  /** サーバーの環境で最後に変換したときに、サーバー関数を定義していたファイルの、ルートからの相対パスごとの ID の集合である。 */
  readonly serverFnIds: ReadonlyMap<string, ReadonlySet<string>>;
  /** 開発サーバーの ssr の環境ごとの、`DevHooks` の ID である。 */
  readonly devIds: WeakMap<Environment, string>;
}

/** 開発サーバーと `vite preview` で、サーバーのエントリーにリクエストを渡すプラグインを返す。 */
export function serve({ settings, writeTypes, serverFnIds, devIds }: ServeContext): Plugin {
  /**
   * ID のサーバー関数を今のソースで定義していれば、`environment` のランナーでそのファイルを読み込んで真を返す。
   * ID のファイルの部分がプロジェクトのファイルなら、`environment` で変換して最新の定義を確認する。`#` を含まない ID には偽を返す。
   */
  const loadServerFn = async (environment: RunnableDevEnvironment, id: string) => {
    const file = moduleOfServerFnId(id);
    if (file === undefined) return false;
    if (!isServerFnSource(file) || !existsSync(resolve(settings().root, file))) {
      return false;
    }
    await environment.transformRequest(`/${file}`);
    if (!serverFnIds.get(file)?.has(id)) return false;
    await environment.runner.import(`/${file}`);
    return true;
  };

  return {
    name: "rinka:serve",
    apply: "serve",
    perEnvironmentStartEndDuringDev: true,
    config: (user) =>
      hasCloudflare(user.plugins ?? [])
        ? { environments: { ssr: { optimizeDeps: { include: serverImports.map(fromApp) } } } }
        : null,
    configurePreviewServer(server) {
      return () => {
        const entry = pathToFileURL(join(settings().outDir, "server/entry.js")).href;
        server.middlewares.use(
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          entryMiddleware(() => import(entry) as Promise<ServerModule>, { forwardErrors: false }),
        );
      };
    },
    configureServer(server) {
      const { root, elementsDir } = settings();
      const routesDir = resolve(root, ROUTES_DIR);
      const routes = virtualId(entries.routes);
      const invalidateRoutes = (): void => {
        for (const environment of Object.values(server.environments)) {
          const node = environment.moduleGraph.getModuleById(routes);
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
      const onFile = (path: string): void => {
        if (inside(routesDir, path) !== undefined && routeFileNames.has(basename(path))) {
          invalidateRoutes();
        }
        if (isPrepareInput(root, elementsDir, path)) rewriteTypes();
      };
      const onDir = (path: string): void => {
        if (inside(routesDir, path) !== undefined) invalidateRoutes();
        if (isPrepareInput(root, elementsDir, path)) rewriteTypes();
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
      const environment = server.environments.ssr;
      if (environment && isRunnable(environment)) {
        const devId = randomUUID();
        devIds.set(environment, devId);
        devHooks().set(devId, {
          styles: async (files) => {
            const nodes = await Promise.all(
              files.map((file) => environment.moduleGraph.getModuleByUrl(`/${file}`)),
            );
            return routeStyles(nodes.filter((node) => node !== undefined));
          },
          onError: recordFailure,
          loadServerFn: (id) => loadServerFn(environment, id),
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
    buildEnd() {
      const id = devIds.get(this.environment);
      if (id !== undefined) devHooks().delete(id);
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

/** リクエストごとの、`rinka/app` の onError が受け取ったエラーの置き場である。 */
const failures = new AsyncLocalStorage<{ error?: unknown }>();

/** 開発中の `rinka/app` の onError で、エラーをリクエストの置き場に記録し、500 の Response を返す。 */
const recordFailure: DevHooks["onError"] = (error) => {
  const failure = failures.getStore();
  if (failure) failure.error = error;
  return new Response(null, { status: 500 });
};

/** サーバーのエントリーのモジュールを表す。 */
interface ServerModule {
  readonly default: ReturnType<CreateApp>;
}

/**
 * `load` が返すサーバーのエントリーの default export の `fetch` に、リクエストを渡すミドルウェアを返す。
 * `forwardErrors` が真なら、`fetch` が投げたエラーと、開発中の `rinka/app` の onError が受け取ったエラーを `next` に渡す。
 * 偽なら、`fetch` が投げたエラーには本文の無い 500 の Response を返す。
 * `load` が undefined を返せば、リクエストを `next` に渡す。
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
      const listener = getRequestListener(
        async (incoming) => {
          const failure: { error?: unknown } = {};
          const result = await failures.run(failure, () => entry.default.fetch(incoming));
          if ("error" in failure) throw failure.error;
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
      );
      await listener(request, response);
    })().catch(next);
  };
}

/**
 * `environment` がモジュールを実行できる開発の環境かどうかを返す。
 * クラスで判定せずに、`runner` の有無で判定する。
 */
const isRunnable = (environment: Environment): environment is RunnableDevEnvironment =>
  "runner" in environment;
