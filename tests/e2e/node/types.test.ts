import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, expect, it } from "vitest";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

/** 型の検査に使用するテスト用のアプリのルートである。 */
const root = fileURLToPath(new URL("../fixtures/types", import.meta.url));

/** rinka の CLI のファイルである。 */
const rinkaBin = join(dirname(fileURLToPath(import.meta.resolve("rinka/vite"))), "bin.js");

/** TypeScript の CLI のファイルである。 */
const tscBin = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");

/** テスト用のアプリで `tsc -b` を実行し、出力と終了コードを返す。 */
async function typecheck(): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await run(process.execPath, [tscBin, "-b", root]);
    return { stdout, code: 0 };
  } catch (error) {
    const { stdout, code } = error as { stdout: string; code: number };
    return { stdout, code };
  }
}

beforeAll(async () => {
  await run(process.execPath, [rinkaBin, "prepare", root]);
}, 60_000);

it("rinka prepare で生成した型宣言と tsconfig で、テスト用のアプリの型の検査が通る", async () => {
  expect(await typecheck()).toEqual({ stdout: "", code: 0 });
}, 60_000);

it("要素のファイルから src/routes/ のファイルを import すると、型の検査が失敗する", async () => {
  const file = join(root, "src/elements/_imports-route.tsx");
  await writeFile(file, 'import Page from "../routes/page.tsx";\n\nvoid Page;\n');
  try {
    const { stdout, code } = await typecheck();
    expect(stdout).toContain("_imports-route.tsx(1,18): error TS6307:");
    expect(code).not.toBe(0);
  } finally {
    await rm(file);
  }
}, 60_000);
