import { rmSync } from "node:fs";
import { join, posix } from "node:path";

import type { Plugin, Rolldown, UserConfig } from "vite";

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

/**
 * 利用者の設定 `config` のクライアントの環境のビルドの設定から、CSS の出力先、minify、CSS のターゲットと、アセットのファイル名を求めた、環境のビルドの設定を返す。
 * CSS のファイル名は内容のハッシュだけにし、ほかのアセットのファイル名は Vite のデフォルトと同じにする。
 */
function cssOutput(config: UserConfig) {
  const client = { ...config.build, ...config.environments?.client?.build };
  const assetsDir = client.assetsDir ?? "assets";
  const cssTarget = client.cssTarget ?? client.target;
  return {
    assetsDir,
    // クライアントの環境の cssMinify のデフォルトと同じ値にする
    cssMinify: client.cssMinify ?? client.minify !== false,
    // Vite は、cssTarget では target の "baseline-widely-available" を解決しない
    ...(cssTarget !== undefined && cssTarget !== "baseline-widely-available" && { cssTarget }),
    rolldownOptions: {
      output: {
        assetFileNames: ({ names }: Rolldown.PreRenderedAsset): string =>
          posix.join(
            assetsDir,
            names.some((name) => name.endsWith(".css")) ? "[hash].css" : "[name]-[hash].[ext]",
          ),
      },
    },
  };
}

/**
 * アプリの `vite build` で、要素のクライアントのビルドと、サーバーのエントリーのサーバーのビルドを、この順に出力するプラグインと、
 * サーバーのビルドで、クライアントのビルドの manifest から要素のファイルとシートの CSS の URL を返す関数の組を返す。
 * サーバーのビルドを開始する前に URL を求めると、その関数はエラーを投げる。
 */
export function appBuild({ options, settings }: SceneContext): {
  readonly plugin: Plugin;
  readonly clientAssets: ClientAssets;
} {
  /** クライアントのビルドの manifest から作成した関数の組である。 */
  let assets: ClientAssets | undefined;
  /** 書き出すルートの範囲である。書き出すルートが無ければ `undefined` である。 */
  let scope: PrerenderScope | undefined;
  const loaded = (file: string): ClientAssets => {
    if (assets === undefined) {
      throw new Error(
        `[rinka] ファイル ${file} の URL を、クライアントのビルドの manifest を読み込む前に求めました。`,
      );
    }
    return assets;
  };
  const plugin: Plugin = {
    name: "rinka:build",
    apply: (_config, { command }) => sceneOf(command, options) === "app",
    enforce: "pre",
    sharedDuringBuild: true,
    applyToEnvironment: (environment) => !isClient(environment),
    config: (config) => {
      const { root, clientDir, serverDir, elements } = settings();
      const css = cssOutput(config);
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
              ...css,
              outDir: clientDir,
              manifest: true,
              rolldownOptions: {
                ...css.rolldownOptions,
                input:
                  elements.length > 0
                    ? elements.map((element) => element.path)
                    : [entries.noElements],
              },
            },
          },
          ssr: {
            build: {
              ...css,
              outDir: serverDir,
              emitAssets: true,
              rolldownOptions: {
                input: {
                  [SERVER_ENTRY_NAME]: file === undefined ? entries.app : join(root, file),
                  ...(scope !== undefined && { [PRERENDER_ENTRY_NAME]: entries.prerender }),
                },
                output: { ...css.rolldownOptions.output, entryFileNames: "[name].js" },
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
    configEnvironment: (name, config) =>
      isServerEnvironment(name, config)
        ? {
            resolve: {
              noExternal: ["@hono/node-server", ...new Set(serverImports.map(packageOf))],
            },
          }
        : null,
    buildStart() {
      assets = readClientAssets(settings().clientDir, settings().root);
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
  return {
    plugin,
    clientAssets: {
      element: (file) => loaded(file).element(file),
      sheet: (path) => loaded(path).sheet(path),
    },
  };
}
