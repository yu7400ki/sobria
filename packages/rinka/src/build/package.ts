import { readFileSync } from "node:fs";

/** rinka の package.json の欄のうち、ビルドと CLI が使用する欄を表す。 */
export interface RinkaPackage {
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<"hono" | "vite", string>>;
  readonly devDependencies: Readonly<Record<"typescript", string>>;
}

/** rinka の package.json を読み込む。 */
export const rinkaPackage = (): RinkaPackage =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as RinkaPackage;
