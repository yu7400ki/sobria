import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
import { moduleOfServerFnId } from "../shared/server-fn.ts";
import { langs, type Lang } from "./ast.ts";
import { embedRouteStyles, moveServerAssets } from "./build-styles.ts";
import { transformSource } from "./compiler.ts";
import { elementTag, scanElements } from "./elements.ts";
import { entries, oxc, runtimes } from "./entries.ts";
import { entryModule, serverIndexModule } from "./entry.ts";
import { transformJsx } from "./jsx.ts";
import { readClientAssets, type ClientAssets } from "./manifest.ts";
import { rinkaPackage } from "./package.ts";
import { devPath, directUrl, inside } from "./paths.ts";
import { preparedFiles, writePrepared } from "./prepare.ts";
import { routeStyles } from "./route-styles.ts";
import { PAGE_FILE, ROUTES_DIR, routeFileNames, routesModule } from "./routes.ts";
import { hashedFnModule, isServerFnSource, serverFnModules } from "./server-fns.ts";
import {
  SHEET_QUERY,
  clientBuildSheetModule,
  clientSheetModule,
  serverBuildSheetModule,
  serverSheetModule,
  sheetId,
  sheetPath,
} from "./sheets.ts";

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
  /** ビルドの出力先である。プロジェクトのルートからの相対パスか絶対パスで記述し、デフォルトは `dist` である。 */
  readonly outDir?: string;
  /** ビルドしたサーバーを起動するランタイムである。デフォルトは `node` である。 */
  readonly deploy?: "node" | "bun";
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

/** rinka のプラグインの名前である。 */
const NAME = "rinka";

/** ルートの表を export する仮想モジュールの ID である。 */
const ROUTES = `\0${entries.routes}`;

/** サーバーのエントリーの仮想モジュールの ID である。 */
const ENTRY = `\0${entries.entry}`;

/** 起動用のエントリーの仮想モジュールの ID である。 */
const SERVER_INDEX = `\0${entries.serverIndex}`;

/** 要素が無いアプリの、クライアントのビルドの入口にする仮想モジュールの ID である。 */
const NO_ELEMENTS = `\0${entries.noElements}`;

/** 本番のサーバーのビルドに含める、rinka と、rinka の依存と、アプリと rinka が共有する hono を返す。 */
const bundled = (): string[] => [entries.main, "hono", ...Object.keys(rinkaPackage().dependencies)];

/** アプリのルート `root` と設定 `options` から、要素のディレクトリとビルドの出力先の絶対パスを返す。 */
const dirsOf = (root: string, options: RinkaOptions) => ({
  elementsDir: resolve(root, options.elementsDir ?? "src/elements"),
  outDir: resolve(root, options.outDir ?? "dist"),
});

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
  let outDir = "";
  let isBuild = false;
  /** サーバーのビルドで読み込んだ、クライアントのビルドの manifest である。 */
  let clientAssets: ClientAssets | undefined;
  /** 要素のファイル `file` を、ブラウザが読み込むときの URL と、静的に import するチャンクの URL を返す。 */
  const elementAssets = (file: string, client: boolean) => {
    if (!isBuild || client) return { module: `/${file}` };
    clientAssets ??= readClientAssets(join(outDir, "client"));
    return clientAssets(file);
  };
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
    const file = moduleOfServerFnId(id);
    if (file === undefined) return false;
    if (!isServerFnSource(file) || !existsSync(resolve(root, file))) {
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
      sharedDuringBuild: true,
      config: (user, { command }) => {
        const dirs = dirsOf(resolve(user.root ?? "."), options);
        const out = dirs.outDir;
        const elements = scanElements(prefix, dirs.elementsDir);
        return {
          appType: "custom",
          oxc,
          optimizeDeps: {
            include: [`${entries.main} > @solidjs/signals`, `${entries.main} > seroval`],
          },
          build: { outDir: join(out, "client") },
          ...(command === "build" && {
            environments: {
              client: {
                build: {
                  outDir: join(out, "client"),
                  manifest: true,
                  rolldownOptions: {
                    input:
                      elements.length > 0
                        ? elements.map((element) => element.path)
                        : [entries.noElements],
                  },
                },
              },
              ssr: {
                build: {
                  outDir: join(out, "server"),
                  emitAssets: true,
                  rolldownOptions: { input: { entry: entries.entry, index: entries.serverIndex } },
                },
              },
            },
            builder: {
              buildApp: async (builder) => {
                await builder.build(builder.environments.client!);
                await builder.build(builder.environments.ssr!);
              },
            },
          }),
        };
      },
      configEnvironment(name, config, { command }) {
        const consumer = config.consumer ?? (name === "client" ? "client" : "server");
        if (consumer !== "server") return null;
        return { resolve: { noExternal: command === "build" ? bundled() : [entries.main] } };
      },
      configResolved(config) {
        if (config.plugins.filter((plugin) => plugin.name === NAME).length > 1) {
          throw new Error(
            "rinka のプラグインが 2 つ以上登録されています。vite.config.ts の plugins に rinka() を 1 回だけ記述してください。",
          );
        }
        root = config.root;
        ({ elementsDir, outDir } = dirsOf(root, options));
        isBuild = config.command === "build";
      },
      buildStart() {
        writeTypes();
      },
      resolveId(id, importer, resolveOptions) {
        if (id === entries.routes) return ROUTES;
        if (id === entries.entry) return ENTRY;
        if (id === entries.serverIndex) return SERVER_INDEX;
        if (id === entries.noElements) return NO_ELEMENTS;
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
        if (id === SERVER_INDEX) return serverIndexModule(options.deploy ?? "node");
        if (id === NO_ELEMENTS) return "export {};\n";
        if (id === ENTRY) {
          return entryModule({ serverFns: serverFnModules(root), trustedOrigins });
        }
        const sheet = sheetPath(id);
        if (sheet === undefined) return null;
        const path = devPath(sheet, root);
        if (isBuild) {
          return isClient(this.environment)
            ? clientBuildSheetModule(`${path}?url`)
            : serverBuildSheetModule(`${path}?url`, `${path}?inline`);
        }
        return isClient(this.environment)
          ? clientSheetModule(`${path}?inline`)
          : serverSheetModule(`${path}?inline`, directUrl(path));
      },
      generateBundle(_output, bundle) {
        if (isBuild && !isClient(this.environment)) embedRouteStyles(bundle, root);
      },
      writeBundle(_output, bundle) {
        if (isBuild && !isClient(this.environment)) {
          moveServerAssets(bundle, join(outDir, "server"), join(outDir, "client"));
        }
      },
      configurePreviewServer(server) {
        return () => {
          const entry = pathToFileURL(join(outDir, "server/entry.js")).href;
          server.middlewares.use((request, response, next) => {
            (async () => {
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              const { app } = (await import(entry)) as { readonly app: ReturnType<CreateApp> };
              await getRequestListener((incoming) => app.fetch(incoming))(request, response);
            })().catch(next);
          });
        };
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
          ...(tag !== undefined && {
            element: { tag, ...elementAssets(target.file, isClient(this.environment)) },
          }),
          ...(isBuild && { fnModule: hashedFnModule(target.file) }),
        });
        if (result.serverFns.length > 0 && !isServerFnSource(target.file)) {
          throw new Error(
            `${target.file}: サーバー関数は、src/ の中のファイルで定義してください。`,
          );
        }
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
