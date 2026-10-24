import type { Plugin } from "vite";

import { inside } from "./paths.ts";
import { DEFAULT_PREFIX, sceneOf, type SceneContext } from "./settings.ts";

/**
 * `library: true` の `vite build` で、アプリの要素を、自分自身を登録する ES モジュールとして
 * 出力先のタグ名のファイルに出力するプラグインを返す。
 */
export function libraryBuild({ options, settings }: SceneContext): Plugin {
  return {
    name: "rinka:library",
    apply: (_config, { command }) => sceneOf(command, options) === "library",
    enforce: "pre",
    sharedDuringBuild: true,
    config: () => {
      const { elementsDir, elements } = settings();
      const own = elements.filter(({ path }) => inside(elementsDir, path) !== undefined);
      return {
        base: "./",
        environments: {
          client: {
            build: {
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
      if (settings().prefix === DEFAULT_PREFIX) {
        config.logger.warn(
          "[rinka] library: true のビルドで、要素のタグ名の接頭辞がデフォルトの rinka のままです。ほかのライブラリとタグ名が重ならないように、rinka({ prefix }) に固有の接頭辞を指定してください。",
        );
      }
    },
  };
}
