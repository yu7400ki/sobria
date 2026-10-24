// rinka の型定義から、API のリファレンスの MDX を生成する。生成しなかったファイルは削除する。
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { apiReferenceDir, apiReferenceSources } from "./api-reference.ts";

const sources = await apiReferenceSources();
const dir = resolve(import.meta.dirname, "..", apiReferenceDir);
mkdirSync(dir, { recursive: true });
for (const file of readdirSync(dir)) {
  if (!(`${apiReferenceDir}/${file}` in sources)) rmSync(resolve(dir, file));
}
for (const [path, content] of Object.entries(sources)) {
  writeFileSync(resolve(import.meta.dirname, "..", path), content);
}
