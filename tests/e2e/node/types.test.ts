import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, it } from "vitest";

import { sobriaBin, run, tscBin, typecheck } from "./typescript.ts";

/** テスト用のライブラリのルートである。 */
const library = fileURLToPath(new URL("../../fixture-library", import.meta.url));

/** 型の検査に使用するテスト用のアプリのコピーのルートである。 */
let root: string;

beforeAll(async () => {
  // sobria を解決できるように、コピーは tests/e2e の中に置く
  root = await mkdtemp(fileURLToPath(new URL("../.sobria-tmp-types-", import.meta.url)));
  await cp(fileURLToPath(new URL("../fixtures/types", import.meta.url)), root, {
    recursive: true,
    filter: (source) => basename(source) !== ".sobria",
  });
  await run(process.execPath, [sobriaBin, "prepare", root]);
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

it("sobria prepare で生成した型宣言と tsconfig で、テスト用のアプリの型の検査が通る", async () => {
  expect(await typecheck(root)).toEqual({ stdout: "", code: 0 });
}, 60_000);

it("tsc が出力したライブラリの型宣言で、ライブラリの要素の props を検査し、load:* を受け付ける", async () => {
  await run(process.execPath, [sobriaBin, "prepare", library]);
  await run(process.execPath, [
    tscBin,
    "-p",
    join(library, ".sobria/tsconfig.elements.json"),
    "--composite",
    "false",
    "--declaration",
    "--rootDir",
    join(library, "src/elements"),
    "--outDir",
    join(library, "types"),
  ]);
  const file = join(root, "src/routes/library/page.tsx");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `import Badge from "@sobria-tests/fixture-library/badge";

export default function Page() {
  return (
    <>
      <Badge label="new" load:visible />
      {/* @ts-expect-error label は文字列である */}
      <Badge label={1} />
    </>
  );
}
`,
  );
  try {
    expect(await typecheck(root)).toEqual({ stdout: "", code: 0 });
  } finally {
    await rm(dirname(file), { recursive: true });
  }
}, 120_000);

it("要素のファイルから src/routes/ のファイルを import すると、型の検査が失敗する", async () => {
  const file = join(root, "src/elements/_imports-route.tsx");
  await writeFile(file, 'import Page from "../routes/page.tsx";\n\nvoid Page;\n');
  const { stdout, code } = await typecheck(root);
  expect(stdout).toContain("_imports-route.tsx(1,18): error TS6307:");
  expect(code).not.toBe(0);
}, 60_000);
