import { join, resolve } from "node:path";

import { normalizePath, type EnvironmentOptions, type Plugin } from "vite";

import { scanElements, type ElementFile, type ElementSource } from "./elements.ts";
import { findLibraries, type Library } from "./libraries.ts";

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

/** 要素のタグ名の接頭辞のデフォルト値である。 */
export const DEFAULT_PREFIX = "rinka";

/** プラグインが動作する場面である。`serve` は開発サーバーと `vite preview`、`app` はアプリのビルド、`library` はライブラリのビルドである。 */
export type Scene = "serve" | "app" | "library";

/** アプリのサーバーのビルドの入力の名前である。出力のファイルの名前は、この名前に `.js` を付けたものになる。 */
export const SERVER_ENTRY_NAME = "entry";

/** Vite の `command` とプラグインの設定 `options` から、場面を返す。 */
export const sceneOf = (command: "build" | "serve", options: RinkaOptions): Scene =>
  command === "serve" ? "serve" : options.library ? "library" : "app";

/** Vite の設定から求めた、プラグインの設定を表す。 */
export interface Settings {
  /** アプリのルートである。`/` で区切る。 */
  readonly root: string;
  readonly prefix: string;
  readonly elementsDir: string;
  /** クライアントのビルドの出力先で、`vite preview` が配信するディレクトリである。ライブラリのビルドでは、出力先そのものである。 */
  readonly clientDir: string;
  /** アプリのサーバーのビルドの出力先である。 */
  readonly serverDir: string;
  readonly scene: Scene;
  /** TSX のソースの形のライブラリである。 */
  readonly libraries: readonly Library[];
  /** アプリと、各ライブラリの、要素の組の列である。先頭はアプリの組である。 */
  readonly sources: readonly ElementSource[];
  /** 設定を求めた時点の、`sources` の要素のファイルである。 */
  readonly elements: readonly ElementFile[];
}

/**
 * Vite のユーザーの設定のルート `userRoot`、`command`、プラグインの設定 `options` から、プラグインの設定を求める。
 * 2 つの要素のファイルが同じタグになれば、エラーを投げる。
 */
export function settingsOf(
  userRoot: string | undefined,
  command: "build" | "serve",
  options: RinkaOptions,
): Settings {
  const root = normalizePath(resolve(userRoot ?? "."));
  const elementsDir = resolve(root, options.elementsDir ?? "src/elements");
  const libraries = findLibraries(root);
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const sources = [{ prefix, elementsDir, dir: root }, ...libraries];
  const outDir = resolve(root, options.outDir ?? "dist");
  return {
    root,
    prefix,
    elementsDir,
    clientDir: options.library ? outDir : join(outDir, "client"),
    serverDir: join(outDir, "server"),
    scene: sceneOf(command, options),
    libraries,
    sources,
    elements: scanElements(sources),
  };
}

/** 場面ごとのプラグインを作成する関数が受け取る値を表す。 */
export interface SceneContext {
  readonly options: RinkaOptions;
  /** `rinka` のプラグインの `config` で求めた設定を返す。 */
  readonly settings: () => Settings;
}

/** 環境がブラウザで実行する環境かどうかを返す。 */
export const isClient = (
  environment: Parameters<NonNullable<Plugin["applyToEnvironment"]>>[0],
): boolean => environment.config.consumer === "client";

/** 名前が `name` で、設定が `config` の環境が、サーバーで実行する環境かどうかを返す。 */
export const isServerEnvironment = (name: string, config: EnvironmentOptions): boolean =>
  (config.consumer ?? (name === "client" ? "client" : "server")) === "server";
