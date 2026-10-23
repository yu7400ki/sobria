import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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

let workspace: string;
let app: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "rinka-create-"));
  app = join(workspace, "app");
  await run(process.execPath, [rinkaBin, "create", app]);
  await Promise.all(
    Object.entries(packages).map(async ([name, target]) => {
      const link = join(app, "node_modules", name);
      await mkdir(dirname(link), { recursive: true });
      await symlink(target, link, "junction");
    }),
  );
  await run(process.execPath, [rinkaBin, "prepare", app]);
}, 60_000);

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

it("rinka create で作成したアプリは、rinka prepare の後に tsc -b の型の検査が通る", async () => {
  expect(await typecheck(app)).toEqual({ stdout: "", code: 0 });
}, 60_000);
