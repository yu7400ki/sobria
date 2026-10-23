import { resolve } from "node:path";

import { normalizePath, type Environment } from "vite";

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

/** Vite の設定から求めた、プラグインの設定を表す。 */
export interface Settings {
  /** アプリのルートである。`/` で区切る。 */
  readonly root: string;
  readonly elementsDir: string;
  readonly outDir: string;
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
  const sources = [
    { prefix: options.prefix ?? DEFAULT_PREFIX, elementsDir, dir: root },
    ...libraries,
  ];
  return {
    root,
    elementsDir,
    outDir: resolve(root, options.outDir ?? "dist"),
    scene: command === "serve" ? "serve" : options.library ? "library" : "app",
    libraries,
    sources,
    elements: scanElements(sources),
  };
}

/** 環境がブラウザで実行する環境かどうかを返す。 */
export const isClient = (environment: Environment): boolean =>
  environment.config.consumer === "client";
