/** サーバー関数を呼び出す HTTP のメソッドである。 */
export type ServerFnMethod = "GET" | "POST";

/** `serverFnRef` を `Symbol.for` で取得するときの名前である。 */
export const serverFnRefName = "rinka.serverFnRef";

/** サーバー関数の ID とメソッドを、関数に保持するときのキーである。 */
export const serverFnRef: unique symbol = Symbol.for(serverFnRefName);

/** サーバー関数の ID とメソッドを表す。 */
export interface ServerFnRef<M extends ServerFnMethod = ServerFnMethod> {
  readonly id: string;
  readonly method: M;
}

/** `value` が ID とメソッドを保持するサーバー関数なら、その ID とメソッドを返す。 */
export function serverFnRefOf(value: unknown): ServerFnRef | undefined {
  if (typeof value !== "function" || !(serverFnRef in value)) return undefined;
  const ref: unknown = value[serverFnRef];
  if (typeof ref !== "object" || ref === null || !("id" in ref) || !("method" in ref))
    return undefined;
  const { id, method } = ref;
  if (typeof id !== "string" || (method !== "GET" && method !== "POST")) return undefined;
  return { id, method };
}

/** クライアントからサーバー関数を呼び出すときのオプションである。 */
export interface CallOptions {
  /** 中止すると、リクエストを中止する。 */
  signal?: AbortSignal;
  /** リクエストに付与するヘッダーである。 */
  headers?: HeadersInit;
}

/** クライアントから呼び出したサーバー関数が、2xx 以外のレスポンスを返したことを表す。 */
export class ServerFnError extends Error {
  /** レスポンスのステータスである。 */
  readonly status: number;
  /** パースしたレスポンスの本文である。JSON でなければ `null` である。 */
  readonly data: unknown;
  /** 受け取ったレスポンスである。 */
  readonly response: Response;

  constructor(response: Response, data: unknown) {
    super(`サーバー関数の呼び出しが、ステータス ${response.status} で失敗しました。`);
    this.name = "ServerFnError";
    this.status = response.status;
    this.data = data;
    this.response = response;
  }
}
