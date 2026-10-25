import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, it } from "vitest";

import { rinkaBin, rinkaDir, run, typecheck, typescriptDir } from "./typescript.ts";

/** tests/e2e の node_modules である。 */
const modules = fileURLToPath(new URL("../node_modules", import.meta.url));

/** 雛形のアプリの node_modules に配置するパッケージと、その実体のディレクトリである。 */
const packages = {
  rinka: rinkaDir,
  hono: join(rinkaDir, "node_modules/hono"),
  "@hono/node-server": join(rinkaDir, "node_modules/@hono/node-server"),
  "@types/node": join(modules, "@types/node"),
  vite: join(modules, "vite"),
  typescript: typescriptDir,
} as const;

/** vite の CLI のファイルである。 */
const viteBin = join(packages.vite, "bin/vite.js");

let workspace: string;
let app: string;

/** `dir` に `rinka create` で雛形のアプリを作成し、依存のパッケージをリンクする。 */
async function createApp(dir: string): Promise<void> {
  await run(process.execPath, [rinkaBin, "create", dir]);
  await Promise.all(
    Object.entries(packages).map(async ([name, target]) => {
      const link = join(dir, "node_modules", name);
      await mkdir(dirname(link), { recursive: true });
      await symlink(target, link, "junction");
    }),
  );
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "rinka-create-"));
  app = join(workspace, "app");
  await createApp(app);
  await run(process.execPath, [rinkaBin, "prepare", app]);
}, 60_000);

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

it("rinka create で作成したアプリは、rinka prepare の後に tsc -b の型の検査が通る", async () => {
  expect(await typecheck(app)).toEqual({ stdout: "", code: 0 });
}, 60_000);

it("要素の無いアプリを static でビルドすると、クライアントの出力に JS のファイルを残さない", async () => {
  const empty = join(workspace, "empty");
  await createApp(empty);
  await rm(join(empty, "src/elements"), { recursive: true });
  await rm(join(empty, "src/lib"), { recursive: true });
  await rm(join(empty, "src/server.ts"));
  await writeFile(
    join(empty, "src/routes/page.tsx"),
    "export default function Page() {\n  return <h1>rinka</h1>;\n}\n",
  );
  await writeFile(
    join(empty, "vite.config.ts"),
    'import { rinka } from "rinka/vite";\nimport { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [rinka({ output: "static" })] });\n',
  );
  await run(process.execPath, [viteBin, "build"], { cwd: empty });
  const files = await readdir(join(empty, "dist"), { recursive: true });
  expect(files.filter((file) => file.endsWith(".js"))).toEqual([]);
  expect(files.some((file) => file.endsWith("index.html"))).toBe(true);
}, 120_000);
