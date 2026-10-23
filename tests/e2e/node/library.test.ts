import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { rinka } from "rinka/vite";
import { createBuilder, createLogger, resolveConfig } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildFixture } from "./production.ts";

/** テスト用のライブラリのルートである。 */
const root = fileURLToPath(new URL("../../fixture-library", import.meta.url));

let outDir: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "rinka-library-"));
  await buildFixture(root, outDir, { prefix: "acme", library: true });
}, 120_000);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe("library: true のビルド", () => {
  it("要素ごとに <タグ名>.js を出力し、共通のコードを chunks/ に分割して、CSS のファイルとサーバーの出力を出力しない", async () => {
    const files = (await readdir(outDir, { recursive: true })).map((file) =>
      file.replaceAll("\\", "/"),
    );
    expect(files.filter((file) => !/^(chunks|assets)\//.test(file)).toSorted()).toEqual([
      "acme-badge.js",
      "acme-counter.js",
      "acme-rating.js",
      "assets",
      "chunks",
    ]);
    expect(files.some((file) => /^chunks\/.+\.js$/.test(file))).toBe(true);
    expect(files.filter((file) => file.endsWith(".css"))).toEqual([]);
  });

  it("出力は rinka と共通のコードを相対パスで import し、CSS の url() をモジュールからの相対パスで解決する", async () => {
    const files = (await readdir(outDir, { recursive: true })).filter((file) =>
      file.endsWith(".js"),
    );
    const code = (
      await Promise.all(files.map((file) => readFile(join(outDir, file), "utf8")))
    ).join("\n");
    const specifiers = [...code.matchAll(/\bfrom\s*["'`]([^"'`]+)["'`]/g)].map(
      ([, specifier]) => specifier!,
    );
    expect(specifiers.filter((specifier) => !specifier.startsWith("."))).toEqual([]);
    const badge = await readFile(join(outDir, "acme-badge.js"), "utf8");
    expect(badge).not.toContain("/assets/");
    expect(badge).toContain("import.meta.url");
  });

  it("接頭辞がデフォルト値の rinka なら、警告を出力する", async () => {
    const out = await mkdtemp(join(tmpdir(), "rinka-library-default-"));
    // ビルドは .rinka/ に書き込むので、ライブラリのコピーをビルドする。rinka を解決できるように、コピーは tests/e2e の中に置く
    const copy = await mkdtemp(fileURLToPath(new URL("../.rinka-tmp-library-", import.meta.url)));
    await cp(root, copy, {
      recursive: true,
      filter: (source) => ![".rinka", "dist", "types", "node_modules"].includes(basename(source)),
    });
    const warnings: string[] = [];
    const logger = createLogger("warn");
    logger.warn = (message) => {
      warnings.push(message);
    };
    try {
      const builder = await createBuilder({
        root: copy,
        configFile: false,
        customLogger: logger,
        plugins: [rinka({ prefix: "rinka", outDir: out, library: true })],
      });
      await builder.buildApp();
    } finally {
      await rm(out, { recursive: true, force: true });
      await rm(copy, { recursive: true, force: true });
    }
    expect(warnings.join("\n")).toMatch(/接頭辞/);
  }, 120_000);

  it("vite preview は、出力先をそのまま配信する", async () => {
    const config = await resolveConfig(
      {
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [rinka({ prefix: "acme", outDir, library: true })],
      },
      "serve",
      "production",
      "production",
      true,
    );
    expect(config.build.outDir).toBe(outDir);
  });
});
