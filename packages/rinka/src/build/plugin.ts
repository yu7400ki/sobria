import { extname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin, ResolvedConfig } from "vite";

import { appBuild } from "./app-build.ts";
import { langs, type Lang } from "./ast.ts";
import { transformSource } from "./compiler.ts";
import { serve } from "./dev-server.ts";
import { sourceTag } from "./elements.ts";
import { clientImports, entries, oxc, runtimes, serverImports, virtualId } from "./entries.ts";
import { buildAppModule } from "./entry.ts";
import { transformJsx } from "./jsx.ts";
import { libraryBuild } from "./library-build.ts";
import { fromApp, packageOf } from "./package.ts";
import { devPath, inside } from "./paths.ts";
import { preparedFiles, writePrepared } from "./prepare.ts";
import { ROUTES_DIR, routesModule } from "./routes.ts";
import { hashedFnModule, isServerFnSource, serverFnModules } from "./server-fns.ts";
import { isClient, settingsOf, type RinkaOptions, type Settings } from "./settings.ts";
import { SHEET_QUERY, sheetId, sheetModule, sheetPath } from "./sheets.ts";

export type { RinkaOptions } from "./settings.ts";

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
const ROUTES = virtualId(entries.routes);

/** rinka のアプリの仮想モジュールの ID である。 */
const APP = virtualId(entries.app);

/** 要素が無いアプリの、クライアントのビルドの入口にする仮想モジュールの ID である。 */
const NO_ELEMENTS = virtualId(entries.noElements);

/** 本番のサーバーのビルドに含める、rinka と、rinka の実行時のコードが import するパッケージと、アプリが起動に使う @hono/node-server を返す。 */
const bundled = (): string[] => [
  entries.main,
  "@hono/node-server",
  ...new Set(serverImports.map(packageOf)),
];

/** 変換するプロジェクトのファイルの、モジュールのパス、ルートからの相対パス、言語を表す。 */
interface ProjectFile {
  readonly path: string;
  readonly file: string;
  readonly lang: Lang;
}

/**
 * rinka の Vite プラグインを作成する。`rinka` の実行時のコードを環境ごとに解決し、
 * プロジェクトのモジュールにコンパイラの変換を適用する。
 */
export function rinka(options: RinkaOptions = {}): Plugin[] {
  const trustedOrigins = options.trustedOrigins ?? [];
  for (const origin of trustedOrigins) checkOrigin(origin);
  /** サーバーの環境で最後に変換したときに、サーバー関数を定義していたファイルの、ルートからの相対パスごとの ID の集合である。 */
  const serverFnIds = new Map<string, ReadonlySet<string>>();
  /** `config` で求めたプラグインの設定である。 */
  let settings: Settings | undefined;
  /** プラグインの設定を返す。`config` のフックより前に呼び出すと、エラーを投げる。 */
  const current = (): Settings => {
    if (settings === undefined) {
      throw new Error(
        "[rinka] rinka のプラグインの設定は、Vite の設定を解決した後に参照してください。",
      );
    }
    return settings;
  };
  /** ルートからの相対パス `file` の、サーバー関数の ID のモジュールの部分を返す。ビルドではパスのハッシュに、開発ではパスにする。 */
  const fnModuleOf = (file: string): string =>
    current().scene === "serve" ? file : hashedFnModule(file);
  const writeTypes = (): void => {
    const { root, prefix, elementsDir } = current();
    writePrepared(
      root,
      preparedFiles({ root, prefix, elementsDir, globalJSX: options.globalJSX ?? true }),
    );
  };
  const api: RinkaApi = { prepare: writeTypes };
  const dev = serve({ options, settings: current, writeTypes, serverFnIds });
  const build = appBuild({ options, settings: current });

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

  return [
    {
      name: NAME,
      enforce: "pre",
      api,
      sharedDuringBuild: true,
      config: (user, { command }) => {
        settings = settingsOf(user.root, command, options);
        const { clientDir, libraries } = settings;
        return {
          appType: "custom",
          oxc,
          optimizeDeps: {
            include: clientImports.map(fromApp),
            exclude: libraries.map((library) => library.name),
          },
          build: { outDir: clientDir },
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
      },
      buildStart() {
        writeTypes();
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
          return scene === "serve"
            ? dev.appModule(this.environment, { serverFns, trustedOrigins })
            : buildAppModule({ serverFns, trustedOrigins });
        }
        const sheet = sheetPath(id);
        return sheet === undefined
          ? null
          : sheetModule(devPath(sheet, root), scene, isClient(this.environment));
      },
      transform(code, id) {
        const target = projectFile(id);
        if (!target) return null;
        const client = isClient(this.environment);
        const { root, scene, sources } = current();
        const tag = sourceTag(sources, target.path);
        const result = transformSource(code, {
          id: target.path,
          file: target.file,
          lang: target.lang,
          client,
          ...(tag !== undefined && {
            element: {
              tag,
              ...(scene === "app" && !client
                ? build.elementAssets(target.file)
                : { module: devPath(target.path, root) }),
            },
          }),
          fnModule: fnModuleOf(target.file),
        });
        if (result.serverFns.length > 0 && !isServerFnSource(target.file)) {
          throw new Error(
            `${target.file}: サーバー関数は、src/ の中のファイルで定義してください。`,
          );
        }
        if (!client) {
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
    dev.plugin,
    build.plugin,
    libraryBuild({ options, settings: current }),
  ];
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
