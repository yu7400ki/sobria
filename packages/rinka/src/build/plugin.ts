import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getRequestListener } from "@hono/node-server";
import {
  normalizePath,
  type Environment,
  type Plugin,
  type ResolvedConfig,
  type UserConfig,
  type RunnableDevEnvironment,
  type ViteDevServer,
} from "vite";

import { reloadEvent } from "../shared/hmr.ts";
import type { CreateApp } from "../shared/routes.ts";
import { moduleOfServerFnId } from "../shared/server-fn.ts";
import { langs, type Lang } from "./ast.ts";
import { embedRouteStyles, moveServerAssets } from "./build-styles.ts";
import { transformSource } from "./compiler.ts";
import { scanElements, sourceTag, type ElementFile, type ElementSource } from "./elements.ts";
import { clientImports, entries, oxc, runtimes, serverImports } from "./entries.ts";
import { appModule, devHooks, serverEntry, type DevHooks } from "./entry.ts";
import { transformJsx } from "./jsx.ts";
import { findLibraries, type Library } from "./libraries.ts";
import { readClientAssets, type ClientAssets } from "./manifest.ts";
import { rinkaPackage } from "./package.ts";
import { devPath, directUrl, inside } from "./paths.ts";
import { isPrepareInput, preparedFiles, writePrepared } from "./prepare.ts";
import { routeStyles } from "./route-styles.ts";
import { ROUTES_DIR, routeFileNames, routesModule } from "./routes.ts";
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
  /** `true` なら、`vite build --app` で、要素ごとに自分自身を登録する ES モジュールを出力する。 */
  readonly library?: true;
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

/** 要素のタグ名の接頭辞のデフォルト値である。 */
const DEFAULT_PREFIX = "rinka";

/** rinka のプラグインの名前である。 */
const NAME = "rinka";

/** ルートの表を export する仮想モジュールの ID である。 */
const ROUTES = `\0${entries.routes}`;

/** rinka のアプリの仮想モジュールの ID である。 */
const APP = `\0${entries.app}`;

/** 要素が無いアプリの、クライアントのビルドの入口にする仮想モジュールの ID である。 */
const NO_ELEMENTS = `\0${entries.noElements}`;

/** モジュールの指定子 `id` のパッケージの名前を返す。 */
const packageOf = (id: string): string =>
  id
    .split("/")
    .slice(0, id.startsWith("@") ? 2 : 1)
    .join("/");

/** モジュールの指定子 `id` を、事前のバンドルでアプリのルートから解決できる形にする。rinka の依存は rinka を経由して解決する。 */
const fromApp = (id: string): string =>
  packageOf(id) in rinkaPackage().dependencies ? `${entries.main} > ${id}` : id;

/** 本番のサーバーのビルドに含める、rinka と、rinka の実行時のコードが import するパッケージと、アプリが起動に使う @hono/node-server を返す。 */
const bundled = (): string[] => [
  entries.main,
  "@hono/node-server",
  ...new Set(serverImports.map(packageOf)),
];

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

/** プラグインが動作する場面である。`serve` は開発サーバーと `vite preview`、`app` はアプリのビルド、`library` はライブラリのビルドである。 */
type Scene = "serve" | "app" | "library";

/** Vite の設定から求めた、プラグインの設定を表す。 */
interface Settings {
  /** アプリのルートである。`/` で区切る。 */
  readonly root: string;
  readonly elementsDir: string;
  readonly outDir: string;
  readonly scene: Scene;
  /** TSX のソースの形のライブラリである。 */
  readonly libraries: readonly Library[];
  /** アプリと、各ライブラリの、要素の組の列である。先頭はアプリの組である。 */
  readonly sources: readonly ElementSource[];
}

/** Vite のユーザーの設定のルート `userRoot`、`command`、プラグインの設定 `options` から、プラグインの設定を求める。 */
function settingsOf(
  userRoot: string | undefined,
  command: "build" | "serve",
  options: RinkaOptions,
): Settings {
  const root = normalizePath(resolve(userRoot ?? "."));
  const elementsDir = resolve(root, options.elementsDir ?? "src/elements");
  const libraries = findLibraries(root);
  return {
    root,
    elementsDir,
    outDir: resolve(root, options.outDir ?? "dist"),
    scene: command === "serve" ? "serve" : options.library ? "library" : "app",
    libraries,
    sources: [{ prefix: options.prefix ?? DEFAULT_PREFIX, elementsDir, dir: root }, ...libraries],
  };
}

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
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const trustedOrigins = options.trustedOrigins ?? [];
  for (const origin of trustedOrigins) checkOrigin(origin);
  /** サーバーの環境で最後に変換したときに、サーバー関数を定義していたファイルの、ルートからの相対パスごとの ID の集合である。 */
  const serverFnIds = new Map<string, ReadonlySet<string>>();
  /** 開発サーバーの ssr の環境ごとの、`DevHooks` の ID である。 */
  const devIds = new WeakMap<Environment, string>();
  /** `config` で求めたプラグインの設定である。 */
  let settings: Settings | undefined;
  /** プラグインの設定を返す。Vite の設定を解決する前に呼び出すと、エラーを投げる。 */
  const current = (): Settings => {
    if (settings === undefined) {
      throw new Error("[rinka] .rinka/ は、Vite の設定を解決した後に生成してください。");
    }
    return settings;
  };
  /** ルートからの相対パス `file` の、サーバー関数の ID のモジュールの部分を返す。ビルドではパスのハッシュに、開発ではパスにする。 */
  const fnModuleOf = (file: string): string =>
    current().scene === "serve" ? file : hashedFnModule(file);
  /** サーバーのビルドで、クライアントのビルドの manifest から要素のファイルの URL を返す関数である。 */
  let clientAssets: ClientAssets | undefined;
  /** 要素のファイルを、ブラウザが読み込むときの URL と、静的に import するチャンクの URL にする。 */
  const elementAssets = ({ path, file }: ProjectFile, client: boolean) => {
    const { root, outDir, scene } = current();
    if (scene === "serve" || client) return { module: devPath(path, root) };
    clientAssets ??= readClientAssets(join(outDir, "client"));
    return clientAssets(file);
  };
  const writeTypes = (): void => {
    const { root, elementsDir } = current();
    writePrepared(
      root,
      preparedFiles({ root, prefix, elementsDir, globalJSX: options.globalJSX ?? true }),
    );
  };
  const api: RinkaApi = { prepare: writeTypes };

  /**
   * モジュールの ID を、クエリの無いプロジェクトかライブラリのファイルなら、ルートからの相対パスと言語にする。
   * ライブラリのファイルのルートからの相対パスは、`../` で始まることがある。
   */
  const projectFile = (id: string): ProjectFile | undefined => {
    const lang = langs[extname(id)];
    if (!lang || id.includes("?") || id.startsWith("\0")) return undefined;
    const { root, sources } = current();
    const owned = sources.some(({ dir }) => {
      const inner = inside(dir, id);
      return inner !== undefined && !inner.split("/").includes("node_modules");
    });
    return owned ? { path: id, file: relative(root, id).split(sep).join("/"), lang } : undefined;
  };

  /**
   * ID のサーバー関数を今のソースで定義していれば、`environment` のランナーでそのファイルを読み込んで真を返す。
   * ID のファイルの部分がプロジェクトのファイルなら、`environment` で変換して最新の定義を確認する。`#` を含まない ID には偽を返す。
   */
  const loadServerFn = async (environment: RunnableDevEnvironment, id: string) => {
    const file = moduleOfServerFnId(id);
    if (file === undefined) return false;
    if (!isServerFnSource(file) || !existsSync(resolve(current().root, file))) {
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
      perEnvironmentStartEndDuringDev: true,
      config: (user, { command }) => {
        settings = settingsOf(user.root, command, options);
        const { root, elementsDir, outDir, scene, libraries, sources } = settings;
        const elements = scanElements(sources);
        const own = elements.filter(({ path }) => inside(elementsDir, path) !== undefined);
        return {
          appType: "custom",
          oxc,
          optimizeDeps: {
            include: clientImports.map(fromApp),
            exclude: libraries.map((library) => library.name),
          },
          build: { outDir: options.library ? outDir : join(outDir, "client") },
          ...(scene === "serve" &&
            hasCloudflare(user.plugins ?? []) && {
              environments: { ssr: { optimizeDeps: { include: serverImports.map(fromApp) } } },
            }),
          ...(scene === "app" && appBuild(outDir, elements, resolveEntry(root))),
          ...(scene === "library" && libraryBuild(outDir, own)),
        };
      },
      configEnvironment(name, config) {
        const consumer = config.consumer ?? (name === "client" ? "client" : "server");
        if (consumer !== "server") return null;
        const { scene, libraries } = current();
        const names = libraries.map((library) => library.name);
        const bundles = scene === "serve" ? [entries.main] : bundled();
        return { resolve: { noExternal: [...bundles, ...names] } };
      },
      configResolved(config) {
        if (config.plugins.filter((plugin) => plugin.name === NAME).length > 1) {
          throw new Error(
            "rinka のプラグインが 2 つ以上登録されています。vite.config.ts の plugins に rinka() を 1 回だけ記述してください。",
          );
        }
        if (current().scene === "library" && prefix === DEFAULT_PREFIX) {
          config.logger.warn(
            "[rinka] library: true のビルドで、要素のタグ名の接頭辞がデフォルトの rinka のままです。ほかのライブラリとタグ名が重ならないように、rinka({ prefix }) に固有の接頭辞を指定してください。",
          );
        }
      },
      buildStart() {
        if (current().scene !== "serve") writeTypes();
      },
      resolveId(id, importer, resolveOptions) {
        if (id === entries.routes) return ROUTES;
        if (id === entries.app) return APP;
        if (id === entries.noElements) return NO_ELEMENTS;
        if (id.endsWith(SHEET_QUERY)) {
          return this.resolve(id.slice(0, -SHEET_QUERY.length), importer, { skipSelf: true }).then(
            (resolved) => resolved && sheetId(resolved.id),
          );
        }
        if (id === entries.server && isClient(this.environment)) {
          if ("scan" in resolveOptions && resolveOptions.scan === true)
            return { id, external: true };
          const from =
            importer === undefined ? undefined : (inside(current().root, importer) ?? importer);
          throw new Error(
            `${from ?? "(不明なファイル)"}: クライアント向けのコードから ${entries.server} を参照しています。${entries.server} の値は、サーバー関数とミドルウェアの定義の式の中でだけ使用できます。型だけを使用する名前は、import type か export type で記述してください。`,
          );
        }
        const entry = runtimes[isClient(this.environment) ? "client" : "server"][id];
        return entry === undefined ? null : fileURLToPath(new URL(`../${entry}`, import.meta.url));
      },
      load(id) {
        const { root, scene } = current();
        if (id === ROUTES) return routesModule(root, ROUTES_DIR);
        if (id === NO_ELEMENTS) return "export {};\n";
        if (id === APP) {
          const serverFns = new Map(serverFnModules(root).map((file) => [fnModuleOf(file), file]));
          if (scene !== "serve") return appModule({ serverFns, trustedOrigins });
          return appModule({
            serverFns,
            trustedOrigins,
            dev: devIds.get(this.environment) ?? "",
          });
        }
        const sheet = sheetPath(id);
        if (sheet === undefined) return null;
        const path = devPath(sheet, root);
        if (scene === "app") {
          return isClient(this.environment)
            ? clientBuildSheetModule(`${path}?url`)
            : serverBuildSheetModule(`${path}?url`, `${path}?inline`);
        }
        return isClient(this.environment)
          ? clientSheetModule(`${path}?inline`)
          : serverSheetModule(`${path}?inline`, directUrl(path));
      },
      generateBundle(_output, bundle) {
        if (current().scene === "app" && !isClient(this.environment)) {
          embedRouteStyles(bundle, current().root);
        }
      },
      writeBundle(_output, bundle) {
        const { outDir, scene } = current();
        if (scene === "app" && !isClient(this.environment)) {
          moveServerAssets(bundle, join(outDir, "server"), join(outDir, "client"));
          rmSync(join(outDir, "client/.vite"), { recursive: true, force: true });
        }
      },
      configurePreviewServer(server) {
        return () => {
          const entry = pathToFileURL(join(current().outDir, "server/entry.js")).href;
          server.middlewares.use((request, response, next) => {
            (async () => {
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              const { default: app } = (await import(entry)) as {
                readonly default: ReturnType<CreateApp>;
              };
              await getRequestListener(async (incoming) => {
                const result = await app.fetch(incoming);
                response.statusCode = result.status;
                return result;
              })(request, response);
            })().catch(next);
          });
        };
      },
      configureServer(server) {
        writeTypes();
        const { root, elementsDir } = current();
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
          server.middlewares.use(appMiddleware(server, serverEntry(root)));
        };
      },
      buildEnd() {
        const id = devIds.get(this.environment);
        if (id !== undefined) devHooks().delete(id);
      },
      transform(code, id) {
        const target = projectFile(id);
        if (!target) return null;
        const tag = sourceTag(current().sources, target.path);
        const result = transformSource(code, {
          id: target.path,
          file: target.file,
          lang: target.lang,
          client: isClient(this.environment),
          ...(tag !== undefined && {
            element: { tag, ...elementAssets(target, isClient(this.environment)) },
          }),
          fnModule: fnModuleOf(target.file),
        });
        if (result.serverFns.length > 0 && !isServerFnSource(target.file)) {
          throw new Error(
            `${target.file}: サーバー関数は、src/ の中のファイルで定義してください。`,
          );
        }
        if (!isClient(this.environment)) {
          const defined = serverFnIds.has(target.file);
          if (result.serverFns.length > 0) serverFnIds.set(target.file, new Set(result.serverFns));
          else serverFnIds.delete(target.file);
          const graph =
            "moduleGraph" in this.environment ? this.environment.moduleGraph : undefined;
          const app = graph?.getModuleById(APP);
          if (app && defined !== serverFnIds.has(target.file)) graph?.invalidateModule(app);
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

/** 開発サーバーのリクエストごとの、`rinka/app` の onError が受け取ったエラーの置き場である。 */
const failures = new AsyncLocalStorage<{ error?: unknown }>();

/** 開発中の `rinka/app` の onError で、エラーをリクエストの置き場に記録し、500 の Response を返す。 */
const recordFailure: DevHooks["onError"] = (error) => {
  const failure = failures.getStore();
  if (failure) failure.error = error;
  return new Response(null, { status: 500 });
};

/** ビルドの出力先 `out` に、要素 `elements` のクライアントのビルドと、サーバーのエントリー `entry` のサーバーのビルドを、この順に出力する設定を返す。 */
const appBuild = (out: string, elements: readonly ElementFile[], entry: string): UserConfig => ({
  environments: {
    client: {
      build: {
        outDir: join(out, "client"),
        manifest: true,
        rolldownOptions: {
          input:
            elements.length > 0 ? elements.map((element) => element.path) : [entries.noElements],
        },
      },
    },
    ssr: {
      build: {
        outDir: join(out, "server"),
        emitAssets: true,
        rolldownOptions: { input: { entry } },
      },
    },
  },
  builder: {
    buildApp: async (builder) => {
      await builder.build(builder.environments.client!);
      await builder.build(builder.environments.ssr!);
    },
  },
});

/** ビルドの出力先 `out` に、要素 `elements` を、自分自身を登録する ES モジュールとしてタグ名のファイルに出力する設定を返す。 */
const libraryBuild = (out: string, elements: readonly ElementFile[]): UserConfig => ({
  base: "./",
  environments: {
    client: {
      build: {
        outDir: out,
        rolldownOptions: {
          input: Object.fromEntries(elements.map((element) => [element.tag, element.path])),
          output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js" },
        },
      },
    },
  },
  builder: {
    buildApp: async (builder) => {
      await builder.build(builder.environments.client!);
    },
  },
});

/** ビルドの入口にする、アプリのルート `root` のサーバーのエントリーを返す。 */
const resolveEntry = (root: string): string => {
  const entry = serverEntry(root);
  return entry === entries.app ? entry : join(root, entry);
};

/**
 * `ssr` の環境のランナーで読み込んだサーバーのエントリー `entry` の default export の `fetch` に、リクエストを渡すミドルウェアを返す。
 * `rinka/app` の onError が受け取ったエラーは `next` に渡す。`ssr` の環境がランナーを持たなければ、リクエストを `next` に渡す。
 */
function appMiddleware(
  server: ViteDevServer,
  entry: string,
): (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void {
  return (request, response, next) => {
    const environment = server.environments.ssr;
    if (!environment || !isRunnable(environment)) {
      next();
      return;
    }
    (async () => {
      const { default: app } = await environment.runner.import<{
        readonly default: ReturnType<CreateApp>;
      }>(entry);
      const listener = getRequestListener(
        async (incoming) => {
          const failure: { error?: unknown } = {};
          const result = await failures.run(failure, () => app.fetch(incoming));
          if ("error" in failure) throw failure.error;
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
