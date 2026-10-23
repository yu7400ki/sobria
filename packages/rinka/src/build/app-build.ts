import { rmSync } from "node:fs";
import { join } from "node:path";

import type { Plugin } from "vite";

import { embedRouteStyles, moveServerAssets } from "./build-styles.ts";
import { entries } from "./entries.ts";
import { serverEntry } from "./entry.ts";
import { readClientAssets, type ClientAssets } from "./manifest.ts";
import { isClient, type RinkaOptions, type Settings } from "./settings.ts";

/**
 * アプリの `vite build --app` で、要素のクライアントのビルドと、サーバーのエントリーのサーバーのビルドを、この順に出力するプラグインを返す。
 * `settings` は、`rinka` のプラグインの `config` で求めた設定を返す。
 * サーバーのビルドを開始するときに、クライアントのビルドの manifest から作成した関数を `onClientAssets` に渡す。
 */
export function appBuild(
  options: RinkaOptions,
  settings: () => Settings,
  onClientAssets: (assets: ClientAssets | undefined) => void,
): Plugin {
  return {
    name: "rinka:build",
    apply: (_config, { command }) => command === "build" && options.library !== true,
    sharedDuringBuild: true,
    config: () => {
      const { root, outDir, elements } = settings();
      const entry = serverEntry(root);
      return {
        environments: {
          client: {
            build: {
              outDir: join(outDir, "client"),
              manifest: true,
              rolldownOptions: {
                input:
                  elements.length > 0
                    ? elements.map((element) => element.path)
                    : [entries.noElements],
              },
            },
          },
          ssr: {
            build: {
              outDir: join(outDir, "server"),
              emitAssets: true,
              rolldownOptions: {
                input: { entry: entry === entries.app ? entry : join(root, entry) },
              },
            },
          },
        },
        builder: {
          buildApp: async (builder) => {
            await builder.build(builder.environments.client!);
            await builder.build(builder.environments.ssr!);
          },
        },
      };
    },
    buildStart() {
      onClientAssets(
        isClient(this.environment)
          ? undefined
          : readClientAssets(join(settings().outDir, "client")),
      );
    },
    generateBundle(_output, bundle) {
      if (!isClient(this.environment)) embedRouteStyles(bundle, settings().root);
    },
    writeBundle(_output, bundle) {
      if (isClient(this.environment)) return;
      const { outDir } = settings();
      moveServerAssets(bundle, join(outDir, "server"), join(outDir, "client"));
      rmSync(join(outDir, "client/.vite"), { recursive: true, force: true });
    },
  };
}
