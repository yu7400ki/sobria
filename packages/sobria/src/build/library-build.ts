import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Plugin } from "vite";

import { manifestOf } from "./element-manifest.ts";
import type { ElementFile } from "./elements.ts";
import { findUp, readJson } from "./libraries.ts";
import { inside, relativePath } from "./paths.ts";
import { serverFnModules } from "./server-fns.ts";
import { DEFAULT_PREFIX, sceneOf, type SceneContext, type Settings } from "./settings.ts";
import type { TypeChecker } from "./type-checker.ts";

/** ライブラリのビルドが出力する、Custom Elements Manifest のファイルの名前である。 */
const MANIFEST = "custom-elements.json";

/** ライブラリのビルドのプラグインを作成する関数が受け取る値を表す。 */
export interface LibraryContext extends SceneContext {
  /** 型チェッカーを返す。起動していなければ起動する。 */
  readonly typeChecker: () => TypeChecker;
}

/**
 * `library: true` の `vite build` で、アプリの要素を、自分自身を登録する ES モジュールとして
 * 出力先のタグ名のファイルに出力し、要素を記述した Custom Elements Manifest を出力先に出力するプラグインを返す。
 * 要素がサーバー関数を定義したファイルを import していれば、そのファイルを列挙して警告する。
 */
export function libraryBuild({ options, settings, typeChecker }: LibraryContext): Plugin {
  return {
    name: "sobria:library",
    apply: (_config, { command }) => sceneOf(command, options) === "library",
    enforce: "pre",
    sharedDuringBuild: true,
    config: () => ({
      base: "./",
      environments: {
        client: {
          build: {
            rolldownOptions: {
              input: Object.fromEntries(
                ownElements(settings()).map((element) => [element.tag, element.path]),
              ),
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
    }),
    configResolved(config) {
      if (settings().prefix === DEFAULT_PREFIX) {
        config.logger.warn(
          "[sobria] library: true のビルドで、要素のタグ名の接頭辞がデフォルトの sobria のままです。ほかのライブラリとタグ名が重ならないように、sobria({ prefix }) に固有の接頭辞を指定してください。",
        );
      }
      const { file, dir } = packageOf(settings().root);
      const output = join(settings().clientDir, MANIFEST);
      const declared = file === undefined ? undefined : readJson(file)["customElements"];
      if (typeof declared !== "string" || resolve(dir, declared) !== output) {
        config.logger.warn(
          `[sobria] library: true のビルドで、package.json の customElements が、出力する Custom Elements Manifest を指していません。package.json に "customElements": "${relativePath(dir, output)}" を記述してください。`,
        );
      }
    },
    generateBundle(_options, bundle) {
      const { root, clientDir } = settings();
      const { dir } = packageOf(root);
      const defined = new Set(serverFnModules(root));
      const bundled = new Set(
        Object.values(bundle).flatMap((output) =>
          output.type === "chunk" ? output.moduleIds.map((id) => relativePath(root, id)) : [],
        ),
      );
      const used = [...defined].filter((file) => bundled.has(file));
      if (used.length > 0) {
        this.environment.logger.warn(
          `[sobria] library: true のビルドで、要素が、サーバー関数を定義した ${used.join("、")} を import しています。ライブラリを使うアプリには、このサーバー関数を処理するサーバーがありません。`,
        );
      }
      const entries = new Map(
        Object.values(bundle).flatMap((output) =>
          output.type === "chunk" && output.isEntry ? [[output.name, output.fileName]] : [],
        ),
      );
      const manifest = manifestOf(
        ownElements(settings()).map(({ tag, path }) => ({
          tag,
          file: relativePath(root, path),
          code: readFileSync(path, "utf8"),
          path: relativePath(dir, join(clientDir, entries.get(tag)!)),
          source: path,
        })),
        typeChecker(),
      );
      this.emitFile({
        type: "asset",
        fileName: MANIFEST,
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}

/** ライブラリ自身の要素のディレクトリにある要素を返す。 */
function ownElements({ elementsDir, elements }: Settings): ElementFile[] {
  return elements.filter(({ path }) => inside(elementsDir, path) !== undefined);
}

/** Vite のルート `root` から上位に向かって探索し、最初に見つかった package.json のパスと、そのディレクトリを返す。見つからなければ、ディレクトリは `root` である。 */
function packageOf(root: string): { readonly file?: string; readonly dir: string } {
  const file = findUp(root, "package.json");
  return file === undefined ? { dir: root } : { file, dir: dirname(file) };
}
