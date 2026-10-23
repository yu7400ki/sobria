import { isSeeding } from "../shared/scope.ts";
import type { CallOptions, ServerFnMethod } from "../shared/server-fn.ts";
import { ServerFnError, withServerFnRef } from "../shared/server-fn.ts";
import {
  isJson,
  isSerovalJson,
  rpcPath,
  rpcQuery,
  wireFormat,
  wireHeader,
} from "../shared/wire.ts";

/** RPC の関数を表す。 */
export type RpcFn = (input?: unknown, options?: CallOptions) => Promise<unknown>;

const codec = () => import("./wire-codec.ts");

/** 解決しない Promise を返す。 */
const never = (): Promise<never> => new Promise(() => {});

/**
 * ID が `id` のサーバー関数を、`method` の RPC で呼び出す関数を返す。
 * 返す関数は、シードの間は通信せずに、解決しない Promise を返す。
 * rinka が組み立てたレスポンスなら、`{ ok }` と `{ s }` の値を返す。`{ redirect }` ならその URL に移動し、返す Promise は解決しない。
 * 2xx 以外のレスポンスは `ServerFnError` として投げ、rinka が組み立てていない 2xx のレスポンスは Response のまま返す。
 */
export function serverFn(id: string, method: ServerFnMethod): RpcFn {
  const call: RpcFn = async (input, { signal, headers } = {}) => {
    if (isSeeding()) return never();
    const plain = input === undefined || isJson(input);
    const encoded =
      input === undefined
        ? undefined
        : JSON.stringify(plain ? input : (await codec()).toJSON(input));
    const sent = new Headers(headers);
    let url = rpcPath(id);
    let body: string | undefined;
    if (method === "GET") {
      if (encoded !== undefined) {
        url += `?${plain ? rpcQuery.json : rpcQuery.seroval}=${encodeURIComponent(encoded)}`;
      }
    } else if (encoded !== undefined) {
      body = encoded;
      sent.set("content-type", "application/json");
      if (!plain) sent.set(wireHeader, wireFormat.seroval);
    }
    const response = await fetch(url, {
      method,
      headers: sent,
      ...(body !== undefined && { body }),
      ...(signal !== undefined && { signal }),
    });
    return read(response);
  };
  return withServerFnRef(call, { id, method });
}

/** 起動スクリプトの `$rinka.c` に `serverFn` を登録する。起動スクリプトを読み込んでいないページでは、何もしない。 */
export function installRpc(): void {
  if (globalThis.$rinka) globalThis.$rinka.c = serverFn;
}

async function read(response: Response): Promise<unknown> {
  const built = response.headers.get(wireHeader) === wireFormat.rpc;
  if (!response.ok) throw new ServerFnError(response, await parsed(response.clone()));
  if (!built) return response;
  const body: unknown = await response.json();
  if (typeof body === "object" && body !== null) {
    if ("ok" in body) return body.ok;
    if ("s" in body && isSerovalJson(body.s)) return (await codec()).fromJSON(body.s);
    if ("redirect" in body && typeof body.redirect === "string") {
      location.assign(body.redirect);
      return never();
    }
  }
  throw new TypeError("サーバー関数のレスポンスの本文が、rinka の RPC の形式ではありません。");
}

/** レスポンスの本文を JSON として読む。JSON でなければ `null` を返す。 */
async function parsed(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}
