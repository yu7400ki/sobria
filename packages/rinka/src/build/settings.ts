import { join, resolve } from "node:path";

import { normalizePath, type EnvironmentOptions } from "vite";

import type { Output } from "../shared/prerender.ts";
import { langs } from "./ast.ts";
import { scanElements, type ElementFile, type ElementSource } from "./elements.ts";
import { findLibraries, type Library } from "./libraries.ts";

/** rinka のプラグインの設定を表す。 */
export interface RinkaOptions {
  /** 要素のタグ名の接頭辞である。デフォルトは `rinka` である。 */
  readonly prefix?: string;
  /** 要素を置くディレクトリである。プロジェクトのルートからの相対パスで記述し、デフォルトは `src/elements` である。 */
  readonly elementsDir?: string;
  /**
   * GET 以外のサーバー関数のリクエストで、別のオリジンのページからでも受け付けるオリジンを列挙する。
   * オリジンは `https://www.example.com` のように、パスと末尾の `/` を付けず、デフォルトのポートを省略して記述する。
   */
  readonly trustedOrigins?: readonly string[];
  /** `false` なら、`.rinka/env.d.ts` でグローバルの `JSX` を宣言しない。 */
  readonly globalJSX?: false;
  /** ビルドの出力先である。プロジェクトのルートからの相対パスか絶対パスで記述し、デフォルトは `dist` である。 */
  readonly outDir?: string;
  /** `true` なら、`vite build` で、要素ごとに自分自身を登録する ES モジュールを出力する。 */
  readonly library?: true;
  /**
   * `'static'` なら、`vite build` ですべてのページを書き出し、サーバーのビルドの出力を削除する。
   * サーバーが必要なルートとサーバー関数があれば、ビルドのエラーにする。デフォルトは `'server'` である。
   */
  readonly output?: Output;
  /**
   * 他の Vite プラグインが TSX のソースに変換するファイルの拡張子（`.mdx` など）を列挙する。
   * 列挙した拡張子のファイルは、`.tsx` のファイルと同じくコンパイルする。列挙した拡張子は、`page`、`layout`、`error`、`not-found` のルートのファイルにも使用できる。
   * 変換するプラグインは、plugins の配列で rinka より前に配置する。
   */
  readonly extensions?: readonly string[];
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
  /** プラグインの設定の `output` に、デフォルト値を補った値である。 */
  readonly output: Output;
  readonly scene: Scene;
  /** TSX のソースの形のライブラリである。 */
  readonly libraries: readonly Library[];
  /** アプリと、各ライブラリの、要素の組の列である。先頭はアプリの組である。 */
  readonly sources: readonly ElementSource[];
  /** 設定を求めた時点の、`sources` の要素のファイルである。 */
  readonly elements: readonly ElementFile[];
  /** プラグインの設定の `extensions` を検証し、デフォルト値の空の配列を補った値である。 */
  readonly extensions: readonly string[];
  /** アプリを配置するパス（Vite の `base`）である。`/` で始まり、`/` で終わる。 */
  readonly base: string;
}

/**
 * Vite のユーザーの設定のルート `userRoot` と `base` の `userBase`、`command`、プラグインの設定 `options`、`parseExtensions` で検証した `extensions` から、プラグインの設定を求める。
 * 2 つの要素のファイルが同じタグになれば、エラーを投げる。ライブラリのビルドでなければ、`/` で始まらない `userBase` をエラーにする。
 */
export function settingsOf(
  userRoot: string | undefined,
  userBase: string | undefined,
  command: "build" | "serve",
  options: RinkaOptions,
  extensions: readonly string[],
): Settings {
  const base = baseOf(userBase, options.library === true);
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
    output: options.output ?? "server",
    scene: sceneOf(command, options),
    libraries,
    sources,
    elements: scanElements(sources),
    extensions,
    base,
  };
}

/**
 * Vite の `base` の `userBase` から、アプリを配置するパスを返す。末尾に `/` が無ければ補う。ライブラリのビルドでは `/` を返す。
 * ライブラリのビルドでなければ、`/` で始まらない `userBase`（相対のパスと完全な URL）をエラーにする。
 */
function baseOf(userBase: string | undefined, library: boolean): string {
  if (library || userBase === undefined) return "/";
  if (!userBase.startsWith("/") || userBase.startsWith("//")) {
    throw new Error(
      `[rinka] Vite の base には、/ で始まるパス（/app/ など）を指定してください。指定された base: ${JSON.stringify(userBase)}`,
    );
  }
  return userBase.endsWith("/") ? userBase : `${userBase}/`;
}

/** rinka や Vite が拡張子で扱いを決める、`extensions` に登録できない拡張子である。 */
const reservedExtensions: ReadonlySet<string> = new Set([
  ...langs.keys(),
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
]);

/**
 * プラグインの設定の `extensions` に、デフォルト値の空の配列を補って返す。
 * `.` の後に英数字だけが続く形でない拡張子、`reservedExtensions` の拡張子、重複した拡張子があれば、エラーを投げる。
 */
export function parseExtensions(extensions: readonly string[] = []): readonly string[] {
  for (const [index, extension] of extensions.entries()) {
    if (!/^\.[a-z0-9]+$/i.test(extension)) {
      throw new Error(
        `extensions の ${JSON.stringify(extension)} は、".mdx" のように、ドットの後に英数字だけが続く形で記述してください。`,
      );
    }
    if (reservedExtensions.has(extension)) {
      throw new Error(
        `extensions の ${JSON.stringify(extension)} は、rinka か Vite が扱う拡張子なので登録できません。`,
      );
    }
    if (extensions.indexOf(extension) !== index) {
      throw new Error(
        `extensions に ${JSON.stringify(extension)} が重複しています。1 回だけ記述してください。`,
      );
    }
  }
  return extensions;
}

/** `origin` が、スキーム、ホスト、ポートだけのオリジンでなければ、エラーを投げる。 */
export function checkOrigin(origin: string): void {
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

/** 場面ごとのプラグインを作成する関数が受け取る値を表す。 */
export interface SceneContext {
  readonly options: RinkaOptions;
  /** `rinka` のプラグインの `config` で求めた設定を返す。 */
  readonly settings: () => Settings;
}

/** 環境がブラウザで実行する環境かどうかを返す。 */
export const isClient = (environment: {
  readonly config: { readonly consumer: string };
}): boolean => environment.config.consumer === "client";

/** 名前が `name` で、設定が `config` の環境が、サーバーで実行する環境かどうかを返す。 */
export const isServerEnvironment = (name: string, config: EnvironmentOptions): boolean =>
  (config.consumer ?? (name === "client" ? "client" : "server")) === "server";
