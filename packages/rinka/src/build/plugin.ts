import { fileURLToPath } from "node:url";

import {
  normalizePath,
  transformWithOxc,
  type Plugin,
  type ResolvedConfig,
  type ViteDevServer,
} from "vite";

import { appBuild } from "./app-build.ts";
import { sourceLangOf, type SourceLang } from "./ast.ts";
import { transformSource } from "./compiler.ts";
import { devAppModule, serve } from "./dev-server.ts";
import { sourceTag } from "./elements.ts";
import { clientImports, entries, oxc, runtimes, virtualId } from "./entries.ts";
import { buildAppModule } from "./entry.ts";
import { ParseError } from "./errors.ts";
import { transformJsx } from "./jsx.ts";
import { libraryBuild } from "./library-build.ts";
import { fromApp } from "./package.ts";
import { devPath, inside, relativePath } from "./paths.ts";
import { elementsConfig, preparedFiles, writePrepared } from "./prepare.ts";
import type { ParamTypeOf } from "./props.ts";
import { routesModule } from "./routes.ts";
import { hashedFnModule, isServerFnSource, serverFnModules } from "./server-fns.ts";
import {
  isClient,
  isServerEnvironment,
  checkOrigin,
  parseExtensions,
  settingsOf,
  type RinkaOptions,
  type Settings,
} from "./settings.ts";
import { SHEET_QUERY, sheetId, sheetModule, sheetPath } from "./sheets.ts";
import {
  createTypeChecker,
  type FileChanges,
  type ParamType,
  type TypeChecker,
} from "./type-checker.ts";

export type { RinkaOptions } from "./settings.ts";

/** 作成、変更、削除を型チェッカーに通知するファイルの拡張子に一致する正規表現である。 */
const SCRIPT = /\.[cm]?[jt]sx?$/;

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

/** 変換するプロジェクトのファイルの、モジュールのパス、ルートからの相対パス、言語、登録した拡張子のファイルかどうかを表す。 */
interface ProjectFile extends SourceLang {
  readonly path: string;
  readonly file: string;
  /** ライブラリのファイルなら真である。 */
  readonly library: boolean;
}

/**
 * rinka の Vite プラグインを作成する。`rinka` の実行時のコードを環境ごとに解決し、
 * プロジェクトのモジュールにコンパイラの変換を適用する。
 */
export function rinka(options: RinkaOptions = {}): Plugin[] {
  const trustedOrigins = options.trustedOrigins ?? [];
  for (const origin of trustedOrigins) checkOrigin(origin);
  const extensions = parseExtensions(options.extensions);
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
      preparedFiles({
        root,
        prefix,
        elementsDir,
        extensions,
        globalJSX: options.globalJSX ?? true,
      }),
    );
  };
  const api: RinkaApi = { prepare: writeTypes };
  /** 型チェッカーである。要素の Props の型を初めて解析するときに起動し、`closeBundle` で終了する。 */
  let checker: TypeChecker | undefined;
  /** 要素のファイルのパスごとに保持する、最後に解析したコードと、第 1 引数の開始位置と、解析の結果である。 */
  const analyzed = new Map<
    string,
    { readonly code: string; readonly position: number; readonly type: ParamType | undefined }
  >();
  /** パス `path` の要素のファイルの、第 1 引数の型を解析する関数を返す。同じコードと位置の解析には、前の結果を返す。 */
  const paramTypeOf =
    (path: string): ParamTypeOf =>
    (code, position) => {
      const last = analyzed.get(path);
      if (last?.code === code && last.position === position) return last.type;
      checker ??= createTypeChecker({ config: elementsConfig(current().root) });
      const type = checker.param(path, code, position);
      analyzed.set(path, { code, position, type });
      // 要素のファイルが export する型を、ほかの要素が import していることがある
      if (last !== undefined) reanalyze();
      return type;
    };
  /** 開発サーバーである。`configureServer` で受け取る。 */
  let devServer: ViteDevServer | undefined;
  /**
   * 開発サーバーで、解析したすべての要素の第 1 引数の型を、最後に解析したコードで解析し直す。
   * 解析の結果が変わった要素のモジュールを、すべての環境で無効にし、HMR が有効なら読み込み直す。
   */
  const reanalyze = (): void => {
    const server = devServer;
    if (server === undefined || checker === undefined) return;
    /** `error` を開発サーバーのログに出力する。 */
    const log = (error: unknown) => {
      server.config.logger.error(error instanceof Error ? error.message : String(error));
    };
    const reloads: Promise<void>[] = [];
    try {
      for (const [element, last] of analyzed) {
        const type = checker.param(element, last.code, last.position);
        if (JSON.stringify(type) === JSON.stringify(last.type)) continue;
        analyzed.set(element, { ...last, type });
        for (const environment of Object.values(server.environments)) {
          for (const module of environment.moduleGraph.getModulesByFile(element) ?? []) {
            environment.moduleGraph.invalidateModule(module);
            reloads.push(environment.reloadModule(module));
          }
        }
      }
    } catch (error) {
      log(error);
    }
    Promise.all(reloads).catch(log);
  };
  /**
   * スクリプトのファイル `path` の作成、変更、削除を型チェッカーに通知し、要素を解析し直す。
   * 解析した要素のファイルの変更では、通知した時点では解析し直さずに、Vite が変換し直したときに解析し直す。
   */
  const onFile = (kind: keyof FileChanges, path: string): void => {
    if (checker === undefined || !SCRIPT.test(path)) return;
    const file = normalizePath(path);
    if (kind === "deleted") analyzed.delete(file);
    checker.notify({ [kind]: [file] });
    if (kind !== "changed" || !analyzed.has(file)) reanalyze();
  };
  const build = appBuild({ options, settings: current });

  /**
   * モジュールの ID を、クエリの無いプロジェクトかライブラリのファイルなら、ルートからの相対パスと言語にする。
   * ライブラリのファイルのルートからの相対パスは、`../` で始まることがある。
   */
  const projectFile = (id: string): ProjectFile | undefined => {
    if (id.includes("?") || id.startsWith("\0")) return undefined;
    const { root, sources } = current();
    const source = sourceLangOf(id, extensions);
    if (!source) return undefined;
    const owner = sources.find(({ dir }) => {
      const inner = inside(dir, id);
      return inner !== undefined && !inner.split("/").includes("node_modules");
    });
    if (!owner) return undefined;
    return {
      path: id,
      file: relativePath(root, id),
      ...source,
      library: owner.dir !== root,
    };
  };

  /**
   * プロジェクトのファイル `target` のソース `code` に、`client` ならクライアント向けの `transformSource` を適用する。
   * ライブラリのファイル、登録した拡張子のファイル、サーバー関数を定義できないファイルでサーバー関数を定義していれば、エラーを投げる。
   */
  const compile = (code: string, target: ProjectFile, client: boolean) => {
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
          paramType: paramTypeOf(target.path),
          ...(scene === "app" && !client
            ? build.clientAssets.element(target.file)
            : { module: devPath(target.path, root) }),
        },
      }),
      fnModule: fnModuleOf(target.file),
    });
    if (result.serverFns.length > 0 && (target.library || !isServerFnSource(target.file))) {
      throw new Error(
        target.registered
          ? `${target.file}: 登録した拡張子のファイルでは、サーバー関数を定義できません。.ts か .tsx のファイルで定義して、import してください。`
          : target.library
            ? `${target.file}: サーバー関数は、ライブラリでは定義できません。アプリの src/ の中のファイルで定義してください。`
            : `${target.file}: サーバー関数は、src/ の中のファイルで定義してください。`,
      );
    }
    return { code: result.code, map: result.map };
  };

  return [
    {
      name: NAME,
      enforce: "pre",
      api,
      sharedDuringBuild: true,
      config: (user, { command }) => {
        settings = settingsOf(user.root, command, options, extensions);
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
        if (!isServerEnvironment(name, config)) return null;
        const names = current().libraries.map((library) => library.name);
        return { resolve: { noExternal: [entries.main, ...names] } };
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
      closeBundle() {
        checker?.close();
        checker = undefined;
        analyzed.clear();
      },
      configureServer(server) {
        devServer = server;
        server.watcher.on("add", (path) => onFile("created", path));
        server.watcher.on("change", (path) => onFile("changed", path));
        server.watcher.on("unlink", (path) => onFile("deleted", path));
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
        const entry = runtimes[isClient(this.environment) ? "client" : "server"].get(id);
        return entry === undefined ? null : fileURLToPath(new URL(`../${entry}`, import.meta.url));
      },
      load(id) {
        const { root, scene } = current();
        if (id === ROUTES) return routesModule(root, extensions);
        if (id === NO_ELEMENTS) return "export {};\n";
        if (id === APP) {
          const serverFns = new Map(serverFnModules(root).map((file) => [fnModuleOf(file), file]));
          return scene === "serve"
            ? devAppModule({ serverFns, trustedOrigins, output: current().output })
            : buildAppModule({ serverFns, trustedOrigins });
        }
        const sheet = sheetPath(id);
        return sheet === undefined
          ? null
          : sheetModule(devPath(sheet, root), scene, isClient(this.environment), () =>
              build.clientAssets.sheet(sheet),
            );
      },
      generateBundle(_output, bundle) {
        for (const [fileName, output] of Object.entries(bundle)) {
          if (output.type === "chunk" && output.facadeModuleId === NO_ELEMENTS)
            delete bundle[fileName];
        }
      },
      transform(code, id) {
        const target = projectFile(id);
        if (!target || target.registered) return null;
        return compile(code, target, isClient(this.environment));
      },
    },
    {
      name: `${NAME}:extensions`,
      sharedDuringBuild: true,
      transform(code, id) {
        const target = projectFile(id);
        if (!target?.registered) return null;
        try {
          return compile(code, target, isClient(this.environment));
        } catch (error) {
          if (!(error instanceof ParseError)) throw error;
          throw new Error(
            `${error.message}\n${target.file} を TSX のソースに変換するプラグインを、plugins の配列で rinka より前に配置してください。`,
            { cause: error },
          );
        }
      },
    },
    {
      name: `${NAME}:oxc`,
      sharedDuringBuild: true,
      async transform(code, id) {
        if (!projectFile(id)?.registered) return null;
        const result = await transformWithOxc(code, id, { lang: "tsx", ...oxc });
        return { code: result.code, map: result.map, moduleType: "js" };
      },
    },
    {
      name: `${NAME}:jsx`,
      sharedDuringBuild: true,
      transform(code, id) {
        const target = projectFile(id);
        if (target?.lang !== "tsx" && target?.lang !== "jsx") return null;
        const result = transformJsx(code, { id: target.path, file: target.file });
        return { code: result.code, map: result.map };
      },
    },
    serve({ options, settings: current, writeTypes }),
    build.plugin,
    libraryBuild({ options, settings: current }),
  ];
}
