import type { Plugin } from "vite";

import { inside } from "./paths.ts";
import { DEFAULT_PREFIX, type RinkaOptions, type Settings } from "./settings.ts";

/**
 * `library: true` の `vite build --app` で、アプリの要素を、自分自身を登録する ES モジュールとして
 * 出力先のタグ名のファイルに出力するプラグインを返す。`settings` は、`rinka` のプラグインの `config` で求めた設定を返す。
 */
export function libraryBuild(options: RinkaOptions, settings: () => Settings): Plugin {
  return {
    name: "rinka:library",
    apply: (_config, { command }) => command === "build" && options.library === true,
    config: () => {
      const { elementsDir, outDir, elements } = settings();
      const own = elements.filter(({ path }) => inside(elementsDir, path) !== undefined);
      return {
        base: "./",
        build: { outDir },
        environments: {
          client: {
            build: {
              outDir,
              rolldownOptions: {
                input: Object.fromEntries(own.map((element) => [element.tag, element.path])),
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
      };
    },
    configResolved(config) {
      if ((options.prefix ?? DEFAULT_PREFIX) === DEFAULT_PREFIX) {
        config.logger.warn(
          "[rinka] library: true のビルドで、要素のタグ名の接頭辞がデフォルトの rinka のままです。ほかのライブラリとタグ名が重ならないように、rinka({ prefix }) に固有の接頭辞を指定してください。",
        );
      }
    },
  };
}
