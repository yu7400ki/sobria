import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, it } from "vitest";

import { rinkaBin, run, typecheck } from "./typescript.ts";

/** 型の検査に使用するテスト用のアプリのコピーのルートである。 */
let root: string;

beforeAll(async () => {
  // rinka を解決できるように、コピーは tests/e2e の中に置く
  root = await mkdtemp(fileURLToPath(new URL("../.rinka-tmp-types-", import.meta.url)));
  await cp(fileURLToPath(new URL("../fixtures/types", import.meta.url)), root, {
    recursive: true,
    filter: (source) => basename(source) !== ".rinka",
  });
  await run(process.execPath, [rinkaBin, "prepare", root]);
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

it("rinka prepare で生成した型宣言と tsconfig で、テスト用のアプリの型の検査が通る", async () => {
  expect(await typecheck(root)).toEqual({ stdout: "", code: 0 });
}, 60_000);

it("要素のファイルから src/routes/ のファイルを import すると、型の検査が失敗する", async () => {
  const file = join(root, "src/elements/_imports-route.tsx");
  await writeFile(file, 'import Page from "../routes/page.tsx";\n\nvoid Page;\n');
  const { stdout, code } = await typecheck(root);
  expect(stdout).toContain("_imports-route.tsx(1,18): error TS6307:");
  expect(code).not.toBe(0);
}, 60_000);
