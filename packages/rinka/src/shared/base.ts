/** アプリを配置するパス（Vite の `base`）を返す。`/` で始まり、`/` で終わる。Vite を通さずに実行したときは `/` を返す。 */
export const base = (): string => import.meta.env?.BASE_URL ?? "/";

/** アプリの中のパス `path`（`/` で始まる）に、アプリを配置するパスを前置する。 */
export const withBase = (path: string): string => `${base()}${path.replace(/^\//, "")}`;
