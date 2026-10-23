import { rmSync } from "node:fs";
import { join } from "node:path";

import type { Plugin } from "vite";

import { embedRouteStyles, moveServerAssets } from "./build-styles.ts";
import { entries } from "./entries.ts";
import { serverEntry } from "./entry.ts";
import { readClientAssets, type ClientAssets } from "./manifest.ts";
import { SERVER_ENTRY_NAME, isClient, sceneOf, type SceneContext } from "./settings.ts";

/**
 * アプリの `vite build --app` で、要素のクライアントのビルドと、サーバーのエントリーのサーバーのビルドを、この順に出力するプラグインと、
 * サーバーのビルドで、クライアントのビルドの manifest から要素のファイルの URL を返す関数を返す。
 * サーバーのビルドを開始する前に URL を求めると、その関数はエラーを投げる。
 */
export function appBuild({ options, settings }: SceneContext): {
  readonly plugin: Plugin;
  readonly elementAssets: ClientAssets;
} {
  /** クライアントのビルドの manifest から作成した関数である。 */
  let clientAssets: ClientAssets | undefined;
  const elementAssets: ClientAssets = (file) => {
    if (clientAssets === undefined) {
      throw new Error(
        `[rinka] 要素のファイル ${file} の URL を、クライアントのビルドの manifest を読み込む前に求めました。`,
      );
    }
    return clientAssets(file);
  };
  const plugin: Plugin = {
    name: "rinka:build",
    apply: (_config, { command }) => sceneOf(command, options) === "app",
    enforce: "pre",
    sharedDuringBuild: true,
    config: () => {
      const { root, clientDir, serverDir, elements } = settings();
      const file = serverEntry(root);
      return {
        environments: {
          client: {
            build: {
              outDir: clientDir,
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
              outDir: serverDir,
              emitAssets: true,
              rolldownOptions: {
                input: { [SERVER_ENTRY_NAME]: file === undefined ? entries.app : join(root, file) },
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
      if (!isClient(this.environment)) clientAssets = readClientAssets(settings().clientDir);
    },
    generateBundle(_output, bundle) {
      if (!isClient(this.environment)) embedRouteStyles(bundle, settings().root);
    },
    writeBundle(_output, bundle) {
      if (isClient(this.environment)) return;
      const { clientDir, serverDir } = settings();
      moveServerAssets(bundle, serverDir, clientDir);
      rmSync(join(clientDir, ".vite"), { recursive: true, force: true });
    },
  };
  return { plugin, elementAssets };
}
