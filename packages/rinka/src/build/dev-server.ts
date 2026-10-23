import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { getRequestListener } from "@hono/node-server";
import type { Environment, Plugin, RunnableDevEnvironment } from "vite";

import { reloadEvent } from "../shared/hmr.ts";
import type { AppOptions, CreateApp } from "../shared/routes.ts";
import { entries, serverImports, virtualId } from "./entries.ts";
import { appCode, serverEntry, serverFnLoaderCode, type AppModuleOptions } from "./entry.ts";
import { fromApp } from "./package.ts";
import { inside } from "./paths.ts";
import { isPrepareInput } from "./prepare.ts";
import { routeStyles } from "./route-styles.ts";
import { ROUTES_DIR, routeFileNames } from "./routes.ts";
import { isServerFnSource } from "./server-fns.ts";
import { SERVER_ENTRY_NAME, isClient, type SceneContext } from "./settings.ts";

/** 開発サーバーが Vite のプロセスで実行し、`rinka/app` が使用する関数を表す。 */
type DevHooks = Required<Pick<AppOptions, "styles" | "onError">>;

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
const devAppModule = ({ serverFns, trustedOrigins }: AppModuleOptions, devId: string): string =>
  appCode(
    [
      `  head: ${JSON.stringify(VITE_CLIENT)},`,
      "  styles: hooks?.styles,",
      "  onError: hooks?.onError,",
      `  loadServerFn: ${serverFnLoaderCode(serverFns)},`,
    ],
    trustedOrigins,
    [
      `const hooks = globalThis[Symbol.for(${JSON.stringify(DEV_HOOKS)})]?.get(${JSON.stringify(devId)});`,
      "",
    ],
  );

/** 開発サーバーのプラグインを作成する関数が受け取る値を表す。 */
export interface ServeContext extends SceneContext {
  /** `.rinka/` を生成する。 */
  readonly writeTypes: () => void;
}

/**
 * 開発サーバーと `vite preview` で、サーバーのエントリーにリクエストを渡すプラグインと、
 * 開発サーバーの環境 `environment` で読み込む `rinka/app` のコードを返す関数を返す。
 */
export function serve({ settings, writeTypes }: ServeContext): {
  readonly plugin: Plugin;
  readonly appModule: (environment: Environment, options: AppModuleOptions) => string;
} {
  /** 開発サーバーの ssr の環境ごとの、`DevHooks` の ID である。 */
  const devIds = new WeakMap<Environment, string>();
  const plugin: Plugin = {
    name: "rinka:serve",
    apply: "serve",
    perEnvironmentStartEndDuringDev: true,
    config: (user) =>
      hasCloudflare(user.plugins ?? [])
        ? { environments: { ssr: { optimizeDeps: { include: serverImports.map(fromApp) } } } }
        : null,
    configurePreviewServer(server) {
      return () => {
        const entry = pathToFileURL(join(settings().serverDir, `${SERVER_ENTRY_NAME}.js`)).href;
        server.middlewares.use(
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          entryMiddleware(() => import(entry) as Promise<ServerModule>, { forwardErrors: false }),
        );
      };
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
      /** サーバー関数を定義できるファイル `path` が変わったら、`rinka/app` を無効にする。 */
      const onSource = (path: string): void => {
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
  return {
    plugin,
    appModule: (environment, options) => devAppModule(options, devIds.get(environment) ?? ""),
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
