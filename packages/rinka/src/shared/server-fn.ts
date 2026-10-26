/** サーバー関数を呼び出す HTTP のメソッドを列挙する。 */
export const serverFnMethods = ["GET", "POST"] as const;

/** サーバー関数を呼び出す HTTP のメソッドである。 */
export type ServerFnMethod = (typeof serverFnMethods)[number];

/** `defineServerFn` でメソッドを省略したときのメソッドである。 */
export const defaultServerFnMethod = "POST" satisfies ServerFnMethod;

/** `value` がサーバー関数のメソッドかどうかを返す。 */
export const isServerFnMethod = (value: unknown): value is ServerFnMethod =>
  serverFnMethods.some((method) => method === value);

/** ID のモジュールの部分が `module` で、変数の名前が `name` のサーバー関数の ID を返す。モジュールの部分は、開発中はファイルのパス、本番のビルドではパスのハッシュである。 */
export const serverFnId = (module: string, name: string): string => `${module}#${name}`;

/** サーバー関数の ID から、ID のモジュールの部分を返す。ID の形式に合わなければ `undefined` を返す。 */
export function moduleOfServerFnId(id: string): string | undefined {
  const separator = id.lastIndexOf("#");
  return separator === -1 ? undefined : id.slice(0, separator);
}

/** `serverFnRef` を `Symbol.for` で取得するときの名前である。 */
export const serverFnRefName = "rinka.serverFnRef";

/** サーバー関数の ID とメソッドを、関数に保持するときのキーである。 */
export const serverFnRef: unique symbol = Symbol.for(serverFnRefName);

/**
 * サーバー関数の ID とメソッドを表す。
 * @internal
 */
export interface ServerFnRef<M extends ServerFnMethod = ServerFnMethod> {
  readonly id: string;
  readonly method: M;
}

/** `fn` に、サーバー関数の ID とメソッドを保持させて返す。 */
export const withServerFnRef = <F extends object>(fn: F, ref: ServerFnRef): F =>
  Object.defineProperty(fn, serverFnRef, { value: ref });

/** `value` が ID とメソッドを保持するサーバー関数なら、その ID とメソッドを返す。 */
export function serverFnRefOf(value: unknown): ServerFnRef | undefined {
  if (typeof value !== "function" || !(serverFnRef in value)) return undefined;
  const ref: unknown = value[serverFnRef];
  if (typeof ref !== "object" || ref === null || !("id" in ref) || !("method" in ref))
    return undefined;
  const { id, method } = ref;
  if (typeof id !== "string" || !isServerFnMethod(method)) return undefined;
  return { id, method };
}

/** クライアントからサーバー関数を呼び出すときのオプションである。 */
export interface CallOptions {
  /** 中止すると、リクエストを中止する。 */
  signal?: AbortSignal;
  /** リクエストに付与するヘッダーである。 */
  headers?: HeadersInit;
  /** GET 以外のサーバー関数をブラウザから呼び出したときに、呼び出したページを描き直すかどうかである。デフォルト値は `true` である。 */
  refresh?: boolean;
}

/** クライアントから呼び出したサーバー関数が、2xx 以外のレスポンスを返したか、ストリームの途中で失敗したことを表す。 */
export class ServerFnError extends Error {
  /** レスポンスのステータスである。ストリームの途中で失敗したときは 500 である。 */
  readonly status: number;
  /** パースしたレスポンスの本文である。JSON でなければ `null` である。 */
  readonly data: unknown;
  /** 受け取ったレスポンスである。 */
  readonly response: Response;

  constructor(response: Response, data: unknown, status: number = response.status) {
    super(`サーバー関数の呼び出しが、ステータス ${status} で失敗しました。`);
    this.name = "ServerFnError";
    this.status = status;
    this.data = data;
    this.response = response;
  }
}
