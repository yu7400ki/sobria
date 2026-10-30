/** アプリを配置するパス（Vite の `base`）を返す。`/` で始まり、`/` で終わる。Vite を通さずに実行したときは `/` を返す。 */
export const base = (): string => import.meta.env?.BASE_URL ?? "/";

/** パス `path` の先頭の `/` を 1 つ除いて、アプリを配置するパス `prefix` に連結する。 */
export const joinBase = (prefix: string, path: string): string =>
  `${prefix}${path.replace(/^\//, "")}`;

/** アプリの中のパス `path`（`/` で始まる）に、アプリを配置するパスを前置する。 */
export const withBase = (path: string): string => joinBase(base(), path);
