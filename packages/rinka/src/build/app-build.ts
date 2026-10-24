import { rmSync } from "node:fs";
import { join, posix } from "node:path";

import type { Plugin, Rolldown } from "vite";

import type { PrerenderScope } from "../shared/prerender.ts";
import { embedRouteStyles, moveServerAssets } from "./build-styles.ts";
import { entries, serverImports, virtualId } from "./entries.ts";
import { serverEntry } from "./entry.ts";
import { readClientAssets, type ClientAssets } from "./manifest.ts";
import { packageOf } from "./package.ts";
import {
  PRERENDER_ENTRY_NAME,
  prerenderModule,
  prerenderFiles,
  writePrerendered,
} from "./prerender.ts";
import { serverFnModules } from "./server-fns.ts";
import {
  SERVER_ENTRY_NAME,
  isClient,
  isServerEnvironment,
  sceneOf,
  type SceneContext,
} from "./settings.ts";

/** `assetsDir` に出力するアセットのファイル名を返す関数を返す。CSS のアセットは内容のハッシュだけを名前にし、ほかのアセットは Vite のデフォルトと同じ名前にする。 */
const assetFileNames =
  (assetsDir: string) =>
  ({ names }: Rolldown.PreRenderedAsset): string =>
    posix.join(
      assetsDir,
      names.some((name) => name.endsWith(".css")) ? "[hash].css" : "[name]-[hash].[ext]",
    );

/**
 * アプリの `vite build` で、要素のクライアントのビルドと、サーバーのエントリーのサーバーのビルドを、この順に出力するプラグインと、
 * サーバーのビルドで、クライアントのビルドの manifest から要素のファイルの URL を返す関数を返す。
 * サーバーのビルドを開始する前に URL を求めると、その関数はエラーを投げる。
 */
export function appBuild({ options, settings }: SceneContext): {
  readonly plugin: Plugin;
  readonly elementAssets: ClientAssets;
} {
  /** クライアントのビルドの manifest から作成した関数である。 */
  let clientAssets: ClientAssets | undefined;
  /** 書き出すルートの範囲である。書き出すルートが無ければ `undefined` である。 */
  let scope: PrerenderScope | undefined;
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
    applyToEnvironment: (environment) => !isClient(environment),
    config: () => {
      const { root, clientDir, serverDir, elements } = settings();
      const file = serverEntry(root);
      if (settings().output === "static") {
        const serverFns = serverFnModules(root);
        if (serverFns.length > 0) {
          throw new Error(
            `[rinka] output: 'static' のアプリでは、サーバー関数を定義できません。サーバー関数を定義したファイル: ${serverFns.join("、")}`,
          );
        }
        scope = { output: "static" };
      } else {
        const files = prerenderFiles(root, settings().extensions);
        scope = files.length > 0 ? { output: "server", files } : undefined;
      }
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
                input: {
                  [SERVER_ENTRY_NAME]: file === undefined ? entries.app : join(root, file),
                  ...(scope !== undefined && { [PRERENDER_ENTRY_NAME]: entries.prerender }),
                },
                output: { entryFileNames: "[name].js" },
              },
            },
          },
        },
        builder: {
          buildApp: async (builder) => {
            await builder.build(builder.environments.client!);
            await builder.build(builder.environments.ssr!);
            const { clientDir: client, serverDir: server } = settings();
            if (scope === undefined) return;
            await writePrerendered(server, client);
            if (scope.output === "static") {
              rmSync(server, { recursive: true, force: true });
              return;
            }
            for (const suffix of [".js", ".js.map"]) {
              rmSync(join(server, `${PRERENDER_ENTRY_NAME}${suffix}`), { force: true });
            }
          },
        },
      };
    },
    configEnvironment: (name, config) => ({
      ...((name === "client" || name === "ssr") && {
        build: {
          rolldownOptions: {
            output: { assetFileNames: assetFileNames(config.build?.assetsDir ?? "assets") },
          },
          // クライアントの環境の cssMinify のデフォルトと同じ値にする
          ...(name === "ssr" && {
            cssMinify: config.build?.cssMinify ?? config.build?.minify !== false,
          }),
        },
      }),
      ...(isServerEnvironment(name, config) && {
        resolve: {
          noExternal: ["@hono/node-server", ...new Set(serverImports.map(packageOf))],
        },
      }),
    }),
    buildStart() {
      clientAssets = readClientAssets(settings().clientDir);
    },
    resolveId: (id) => (id === entries.prerender ? virtualId(id) : null),
    load: (id) =>
      id === virtualId(entries.prerender) && scope !== undefined ? prerenderModule(scope) : null,
    generateBundle(_output, bundle) {
      embedRouteStyles(bundle, settings().root);
      this.emitFile({
        type: "asset",
        fileName: "package.json",
        source: `${JSON.stringify({ type: "module" })}\n`,
      });
    },
    writeBundle(_output, bundle) {
      const { clientDir, serverDir } = settings();
      moveServerAssets(bundle, serverDir, clientDir);
      rmSync(join(clientDir, ".vite"), { recursive: true, force: true });
    },
  };
  return { plugin, elementAssets };
}
