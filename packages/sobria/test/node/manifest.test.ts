import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readClientAssets, type ClientAssets } from "../../src/build/manifest.ts";

let outDir: string;
let assets: ClientAssets;
/** テスト用のアプリのルートである。 */
const root = join(tmpdir(), "sobria-manifest-root");

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "sobria-manifest-"));
  await mkdir(join(outDir, ".vite"));
  const manifest = {
    "src/elements/a.tsx": { file: "assets/a-1.js", imports: ["_shared.js"] },
    "_shared.js": { file: "assets/shared-2.js" },
    [join(root, "src/styles/app.css").replaceAll("\\", "/")]: { file: "assets/3.css" },
  };
  await writeFile(join(outDir, ".vite/manifest.json"), JSON.stringify(manifest));
  assets = readClientAssets(outDir, root, "/");
});

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe("クライアントのビルドの manifest", () => {
  it("要素のファイルのモジュールの URL と、静的に import するチャンクの URL を返す", () => {
    expect(assets.element("src/elements/a.tsx")).toEqual({
      module: "/assets/a-1.js",
      chunks: ["/assets/shared-2.js"],
    });
  });

  it("絶対パスの CSS のファイルから、シートとして出力した CSS の URL を返す", () => {
    expect(assets.sheet(join(root, "src/styles/app.css"))).toBe("/assets/3.css");
  });

  it("manifest に無い CSS のファイルのシートの URL を求めると、エラーを投げる", () => {
    expect(() => assets.sheet(join(root, "src/styles/missing.css"))).toThrow(
      "クライアントのビルドの manifest にありません",
    );
  });
});
