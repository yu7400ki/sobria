// DOM の型定義から、名前の一覧のファイルを生成する。
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { domNameSources } from "./dom-names.ts";

for (const [path, content] of Object.entries(domNameSources())) {
  writeFileSync(resolve(import.meta.dirname, "..", path), content);
}
