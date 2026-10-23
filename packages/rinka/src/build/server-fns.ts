import { createHash } from "node:crypto";

/** 本番のビルドで、ファイルのパス `file` から、サーバー関数の ID のモジュールの部分を返す。 */
export const hashedFnModule = (file: string): string =>
  `m${createHash("sha256").update(file).digest("base64url").slice(0, 10)}`;
