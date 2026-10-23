import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, expect, it } from "vitest";

const run = promisify(execFile);

/** rinka のパッケージのディレクトリである。 */
const rinkaDir = resolve(dirname(fileURLToPath(import.meta.resolve("rinka/vite"))), "../..");

/** tests/e2e の node_modules である。 */
const modules = fileURLToPath(new URL("../node_modules", import.meta.url));

/** 雛形のアプリの node_modules に配置するパッケージと、その実体のディレクトリである。 */
const packages: Readonly<Record<string, string>> = {
  rinka: rinkaDir,
  hono: join(rinkaDir, "node_modules/hono"),
  vite: join(modules, "vite"),
  typescript: join(modules, "typescript"),
};

let workspace: string;
let app: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "rinka-create-"));
  app = join(workspace, "app");
  const bin = join(rinkaDir, "lib/build/bin.js");
  await run(process.execPath, [bin, "create", app]);
  await mkdir(join(app, "node_modules"));
  await Promise.all(
    Object.entries(packages).map(([name, target]) =>
      symlink(target, join(app, "node_modules", name), "junction"),
    ),
  );
  await run(process.execPath, [bin, "prepare", app]);
}, 60_000);

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

it("rinka create で作成したアプリは、rinka prepare の後に tsc -b の型の検査が通る", async () => {
  const tsc = join(packages.typescript!, "bin/tsc");
  const result = await run(process.execPath, [tsc, "-b", app]).then(
    ({ stdout }) => ({ stdout, code: 0 }),
    (error: { stdout: string; code: number }) => ({ stdout: error.stdout, code: error.code }),
  );
  expect(result).toEqual({ stdout: "", code: 0 });
}, 60_000);
