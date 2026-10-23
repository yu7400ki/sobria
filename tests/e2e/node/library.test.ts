import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { rinka } from "rinka/vite";
import { createBuilder, createLogger } from "vite";
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
    expect(files.filter((file) => !file.startsWith("chunks/")).toSorted()).toEqual([
      "acme-badge.js",
      "acme-counter.js",
      "acme-rating.js",
      "chunks",
    ]);
    expect(files.some((file) => /^chunks\/.+\.js$/.test(file))).toBe(true);
    expect(files.filter((file) => file.endsWith(".css"))).toEqual([]);
  });

  it("接頭辞がデフォルトのままなら、警告を出力する", async () => {
    const out = await mkdtemp(join(tmpdir(), "rinka-library-default-"));
    const warnings: string[] = [];
    const logger = createLogger("warn");
    logger.warn = (message) => {
      warnings.push(message);
    };
    try {
      const builder = await createBuilder({
        root,
        configFile: false,
        customLogger: logger,
        plugins: [rinka({ outDir: out, library: true })],
      });
      await builder.buildApp();
    } finally {
      await rm(out, { recursive: true, force: true });
    }
    expect(warnings.join("\n")).toMatch(/接頭辞/);
  }, 120_000);
});
