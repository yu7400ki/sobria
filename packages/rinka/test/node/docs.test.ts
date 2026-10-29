import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, expect, it } from "vitest";

import { copyDocs, docsSource } from "../../scripts/docs.ts";

const temporaries: string[] = [];

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `dir` の下のファイルのパスを、`dir` からの相対パスで、`/` で区切って、文字列として比較した順に返す。 */
const filesOf = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .toSorted();

it("ドキュメントサイトの本文の .mdx だけを、ディレクトリの構成のままコピーし、前にコピーしたファイルを残さない", () => {
  const dest = mkdtempSync(join(tmpdir(), "rinka-docs-"));
  temporaries.push(dest);
  writeFileSync(join(dest, "stale.mdx"), "");
  copyDocs(dest);
  const expected = filesOf(docsSource).filter((file) => file.endsWith(".mdx"));
  expect(expected).toContain("introduction/quick-start.mdx");
  expect(filesOf(dest)).toEqual(expected);
});
