// rinka の型定義から、API のリファレンスの MDX を生成する。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { apiReferenceSources } from "./api-reference.ts";

for (const [path, content] of Object.entries(await apiReferenceSources())) {
  const file = resolve(import.meta.dirname, "..", path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
