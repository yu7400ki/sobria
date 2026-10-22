import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

import { tagFromPath } from "../shared/names.ts";
import { transformSource, type Lang } from "./compiler.ts";
import { transformJsx } from "./jsx.ts";

/** rinka のプラグインの設定を表す。 */
export interface RinkaOptions {
  /** 要素のタグ名の接頭辞である。デフォルトは `rinka` である。 */
  readonly prefix?: string;
  /** 要素を置くディレクトリである。プロジェクトのルートからの相対パスで記述し、デフォルトは `src/elements` である。 */
  readonly elementsDir?: string;
}

/** 環境ごとの実行時のコードの入口を、`lib/` からの相対パスで表す。 */
const runtimes: Readonly<Record<"client" | "server", Readonly<Record<string, string>>>> = {
  client: {
    rinka: "client/index.js",
    "rinka/jsx-runtime": "client/jsx-runtime.js",
    "rinka/internal": "client/internal.js",
  },
  server: {
    rinka: "server/index.js",
    "rinka/jsx-runtime": "server/jsx-runtime.js",
  },
};

/** 拡張子ごとの、変換する言語である。 */
const langs: Readonly<Record<string, Lang>> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
};

/** rinka のプラグインの名前である。 */
const NAME = "rinka";

/**
 * rinka の Vite プラグインを作成する。`rinka` の実行時のコードを環境ごとに解決し、
 * プロジェクトのモジュールにコンパイラの変換を適用する。
 */
export function rinka(options: RinkaOptions = {}): Plugin[] {
  const prefix = options.prefix ?? "rinka";
  let root = "";
  let elementsDir = "";

  /** モジュールの ID を、変換するプロジェクトのファイルなら、ルートからの相対パスと言語にする。 */
  const projectFile = (id: string): { path: string; file: string; lang: Lang } | undefined => {
    const [path = ""] = id.split("?");
    const lang = langs[extname(path)];
    if (!lang || path.includes("/node_modules/") || path.startsWith("\0")) return undefined;
    const file = relative(root, path).split(sep).join("/");
    if (file.startsWith("../")) return undefined;
    return { path, file, lang };
  };

  /** 要素のファイルなら、タグ名を返す。 */
  const tagOf = (path: string, lang: Lang): string | undefined => {
    if (lang !== "tsx" && lang !== "jsx") return undefined;
    const inner = relative(elementsDir, path).split(sep).join("/");
    if (inner.startsWith("../") || inner.split("/").some((part) => part.startsWith("_"))) {
      return undefined;
    }
    return tagFromPath(prefix, inner);
  };

  return [
    {
      name: NAME,
      enforce: "pre",
      config: () => ({
        appType: "custom",
        oxc: { jsx: { runtime: "automatic", importSource: "rinka", development: false } },
        ssr: { noExternal: ["rinka"] },
      }),
      configResolved(config) {
        if (config.plugins.filter((plugin) => plugin.name === NAME).length > 1) {
          throw new Error(
            "rinka のプラグインが 2 つ以上登録されています。vite.config.ts の plugins に rinka() を 1 回だけ記述してください。",
          );
        }
        root = config.root;
        elementsDir = resolve(root, options.elementsDir ?? "src/elements");
      },
      resolveId(id) {
        const side = this.environment.name === "client" ? "client" : "server";
        const entry = runtimes[side][id];
        return entry === undefined ? null : fileURLToPath(new URL(`../${entry}`, import.meta.url));
      },
      transform(code, id) {
        const target = projectFile(id);
        if (!target) return null;
        const tag = tagOf(target.path, target.lang);
        const result = transformSource(code, {
          file: target.file,
          lang: target.lang,
          client: this.environment.name === "client",
          ...(tag !== undefined && { element: { tag } }),
        });
        return { code: result.code, map: result.map };
      },
    },
    {
      name: `${NAME}:jsx`,
      transform(code, id) {
        const target = projectFile(id);
        if (target?.lang !== "tsx" && target?.lang !== "jsx") return null;
        const result = transformJsx(code, target.file);
        return { code: result.code, map: result.map };
      },
    },
  ];
}
