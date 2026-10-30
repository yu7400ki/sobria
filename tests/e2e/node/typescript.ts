import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);

/** `execFile` を Promise で包んだ関数である。 */
export const run = promisify(execFile);

/** sobria のパッケージのディレクトリである。 */
export const sobriaDir = resolve(
  dirname(fileURLToPath(import.meta.resolve("sobria/vite"))),
  "../..",
);

/** sobria の CLI のファイルである。 */
export const sobriaBin = join(sobriaDir, "lib/build/bin.js");

/** TypeScript のパッケージのディレクトリである。 */
export const typescriptDir = dirname(require.resolve("typescript/package.json"));

/** TypeScript の CLI のファイルである。 */
export const tscBin = join(typescriptDir, "bin/tsc");

/** アプリのルート `root` で `tsc -b` を実行し、出力と終了コードを返す。 */
export async function typecheck(root: string): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await run(process.execPath, [tscBin, "-b", root]);
    return { stdout, code: 0 };
  } catch (error) {
    const { stdout, code } = error as { stdout: string; code: number };
    return { stdout, code };
  }
}
