import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { create, prepareApp } from "../../src/build/cli.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 空の一時ディレクトリを作成して返す。 */
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), "rinka-cli-"));
  dirs.push(dir);
  return dir;
};

describe("rinka create", () => {
  it("ページ、レイアウト、要素、サーバー関数を 1 つずつ持つアプリの雛形を作成する", () => {
    const dir = join(temporary(), "my-app");
    create(dir);
    expect(
      readdirSync(dir, { recursive: true, encoding: "utf8" })
        .map((file) => file.replaceAll("\\", "/"))
        .toSorted(),
    ).toEqual([
      ".gitignore",
      "package.json",
      "src",
      "src/elements",
      "src/elements/greeter.tsx",
      "src/lib",
      "src/lib/greet.ts",
      "src/routes",
      "src/routes/layout.tsx",
      "src/routes/page.tsx",
      "tsconfig.base.json",
      "tsconfig.json",
      "vite.config.ts",
    ]);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-app");
    const rinka = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.dependencies).toEqual({
      hono: rinka.peerDependencies.hono,
      rinka: `^${rinka.version}`,
    });
    expect(pkg.devDependencies).toEqual({
      typescript: rinka.devDependencies.typescript,
      vite: rinka.peerDependencies.vite,
    });
    expect(pkg.scripts).toEqual({
      dev: "vite",
      build: "vite build --app",
      preview: "vite preview",
      start: "node dist/server/index.js",
      typecheck: "rinka prepare && tsc -b",
    });
    expect(readFileSync(join(dir, ".gitignore"), "utf8").split("\n")).toContain(".rinka");
    expect(JSON.parse(readFileSync(join(dir, "tsconfig.base.json"), "utf8"))).toEqual({
      compilerOptions: { strict: true },
    });
  });

  it("空でないディレクトリには作成せず、エラーを投げる", () => {
    const dir = temporary();
    writeFileSync(join(dir, "README.md"), "");
    expect(() => create(dir)).toThrow(/空/);
    expect(readdirSync(dir)).toEqual(["README.md"]);
  });
});

describe("rinka prepare", () => {
  it("vite.config に rinka のプラグインが無ければ、エラーを投げる", async () => {
    await expect(prepareApp(temporary())).rejects.toThrow(/rinka\(\)/);
  });
});
