import { readFileSync } from "node:fs";

import { entries } from "./entries.ts";

/** rinka の package.json の欄のうち、版と依存の欄を表す。 */
export interface RinkaPackage {
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<"hono" | "vite", string>>;
  readonly devDependencies: Readonly<Record<"typescript" | "@types/node", string>>;
}

/** rinka の package.json を読み込む。 */
export const rinkaPackage = (): RinkaPackage =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as RinkaPackage;

/** モジュールの指定子 `id` のパッケージの名前を返す。 */
export const packageOf = (id: string): string =>
  id
    .split("/")
    .slice(0, id.startsWith("@") ? 2 : 1)
    .join("/");

/** モジュールの指定子 `id` を、事前のバンドルでアプリのルートから解決できる形にする。rinka の依存は rinka を経由して解決する。 */
export const fromApp = (id: string): string =>
  packageOf(id) in rinkaPackage().dependencies ? `${entries.main} > ${id}` : id;
