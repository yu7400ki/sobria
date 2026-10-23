import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { resolveConfig } from "vite";

import { entries } from "./entries.ts";
import { rinkaPackage } from "./package.ts";
import { rinkaApi } from "./plugin.ts";
import { PREPARED_DIR, PROJECTS, projectConfig } from "./prepare.ts";

/** `value` を、整形した JSON のファイルの内容にする。 */
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** 雛形のファイルの、アプリのルートからの相対パスごとの内容を返す。`name` はアプリの名前である。 */
function templateFiles(name: string): Record<string, string> {
  const { version, dependencies, peerDependencies, devDependencies } = rinkaPackage();
  return {
    "package.json": json({
      name,
      private: true,
      type: "module",
      scripts: {
        dev: "vite",
        build: "vite build --app",
        preview: "vite preview",
        start: "node dist/server/entry.js",
        typecheck: "rinka prepare && tsc -b",
      },
      dependencies: {
        "@hono/node-server": dependencies["@hono/node-server"],
        hono: peerDependencies.hono,
        rinka: `^${version}`,
      },
      devDependencies: {
        "@types/node": devDependencies["@types/node"],
        typescript: devDependencies.typescript,
        vite: peerDependencies.vite,
      },
    }),
    "vite.config.ts": `import { rinka } from "${entries.main}/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [rinka()],
});
`,
    "tsconfig.json": json({
      files: [],
      references: PROJECTS.map((project) => ({
        path: `./${PREPARED_DIR}/${projectConfig(project)}`,
      })),
    }),
    "tsconfig.base.json": json({ compilerOptions: { strict: true } }),
    ".gitignore": `node_modules\ndist\n${PREPARED_DIR}\n`,
    "src/server.ts": `/// <reference types="node" />

import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import app from "${entries.app}";

const server = new Hono();
if (import.meta.main) {
  server.use(serveStatic({ root: fileURLToPath(new URL("../client", import.meta.url)) }));
}
server.route("/", app);

if (import.meta.main) serve({ fetch: server.fetch, port: Number(process.env.PORT ?? 3000) });

export default server;
`,
    "src/lib/greet.ts": `import { defineServerFn } from "${entries.server}";

export const greet = defineServerFn(() => "こんにちは");
`,
    "src/elements/greeter.tsx": `import { signal } from "${entries.main}";

import { greet } from "../lib/greet.ts";

export default function Greeter() {
  const [message, setMessage] = signal("");
  return <button onClick={async () => setMessage(await greet())}>{message() || "挨拶する"}</button>;
}
`,
    "src/routes/layout.tsx": `import type { LayoutProps } from "${entries.router}";

export default function Layout(props: LayoutProps) {
  return <main>{props.children}</main>;
}
`,
    "src/routes/page.tsx": `import Greeter from "../elements/greeter.tsx";

export default function Page() {
  return (
    <>
      <h1>rinka</h1>
      <Greeter />
    </>
  );
}
`,
  };
}

/** ディレクトリ `dir` に、アプリの雛形を作成する。`dir` が空でなければ、エラーを投げる。 */
export function create(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(
      `${dir} は空ではありません。空のディレクトリか、存在しないディレクトリを指定してください。`,
    );
  }
  for (const [file, content] of Object.entries(templateFiles(basename(resolve(dir))))) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

/** ディレクトリ `root` のアプリの vite.config を読み込み、rinka のプラグインの設定で `.rinka/` を生成する。 */
export async function prepareApp(root: string): Promise<void> {
  const config = await resolveConfig({ root, logLevel: "error" }, "serve");
  const api = rinkaApi(config);
  if (api === undefined) {
    throw new Error(
      `${root} の vite.config に rinka のプラグインがありません。plugins に rinka() を記述してください。`,
    );
  }
  api.prepare();
}

/** コマンドライン引数 `args` の副コマンドを実行する。 */
export async function main(args: readonly string[]): Promise<void> {
  const [command, target] = args;
  switch (command) {
    case "prepare":
      return prepareApp(resolve(target ?? "."));
    case "create":
      if (target === undefined)
        throw new Error("rinka create には、作成するディレクトリを指定してください。");
      return create(resolve(target));
    case undefined:
    default:
      throw new Error("rinka prepare [root] か rinka create <dir> を実行してください。");
  }
}
