import { PAGE_HEADER, withoutHash } from "../shared/refresh.ts";
import { isSeeding } from "../shared/scope.ts";
import type { CallOptions, ServerFnMethod } from "../shared/server-fn.ts";
import { ServerFnError, withServerFnRef } from "../shared/server-fn.ts";
import {
  isJson,
  isRedirectJson,
  isSerovalJson,
  rpcPath,
  rpcQuery,
  wireFormat,
  wireHeader,
} from "../shared/wire.ts";
import { reflectPage, startRewrite, type Reflect } from "./refresh.ts";

/** RPC の関数を表す。 */
export type RpcFn = (input?: unknown, options?: CallOptions) => Promise<unknown>;

const codec = () => import("./wire-codec.ts");

/** 解決しない Promise を返す。 */
const never = (): Promise<never> => new Promise(() => {});

/**
 * ID が `id` のサーバー関数を、`method` の RPC で呼び出す関数を返す。
 * 返す関数は、シードの間は通信せずに、解決しない Promise を返す。
 * GET 以外では、呼び出しのオプションの `refresh` が `false` でなければ、現在のページの URL を `x-rinka-page` で送る。
 * rinka が組み立てたレスポンスなら、`{ ok }` と `{ s }` の値を返す。`x-rinka-page` を送ったときは、値を返す前にレスポンスの `page` を反映し、`page` が描き直しの JSON でなければページを読み込み直す。
 * `{ redirect }` は、`x-rinka-page` を送り、移動先が現在のページ（hash を除く）なら、`page` を反映して `undefined` を返す。`page` が描き直しの JSON でなければ、ページを読み込み直す。
 * それ以外の `{ redirect }` では、その URL に移動する。`{ redirect }` でページを読み込み直すときと移動するときは、返す Promise は解決しない。
 * 2xx 以外のレスポンスは `ServerFnError` として投げ、rinka が組み立てていない 2xx のレスポンスは Response のまま返す。
 */
export function serverFn(id: string, method: ServerFnMethod): RpcFn {
  const call: RpcFn = async (input, { signal, headers, refresh = true } = {}) => {
    if (isSeeding()) return never();
    const plain = input === undefined || isJson(input);
    const encoded =
      input === undefined
        ? undefined
        : JSON.stringify(plain ? input : (await codec()).toJSON(input));
    const sent = new Headers(headers);
    const reflect = method !== "GET" && refresh ? startRewrite() : undefined;
    if (reflect) sent.set(PAGE_HEADER, location.href);
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
    return read(response, new URL(url, location.href), reflect);
  };
  return withServerFnRef(call, { id, method });
}

/** 起動スクリプトの `$rinka.c` に `serverFn` を登録する。起動スクリプトを読み込んでいないページでは、何もしない。 */
export function installRpc(): void {
  if (globalThis.$rinka) globalThis.$rinka.c = serverFn;
}

/**
 * RPC の `response` から値を返す。`reflect` があれば、値を返す前に、レスポンスの `page` を `reflect` で反映する。
 * 移動先を伝える JSON は、`endpoint` を基準に解決する。`reflect` があり、移動先が現在のページなら `page` を反映し、それ以外では移動先に移動する。
 */
async function read(
  response: Response,
  endpoint: URL,
  reflect: Reflect | undefined,
): Promise<unknown> {
  const built = response.headers.get(wireHeader) === wireFormat.rpc;
  if (!response.ok) throw new ServerFnError(response, await parsed(response.clone()));
  if (!built) return response;
  const body: unknown = await response.json();
  if (typeof body === "object" && body !== null) {
    const page = "page" in body ? body.page : undefined;
    if ("ok" in body) {
      if (reflect) reflectPage(reflect, page);
      return body.ok;
    }
    if ("s" in body && isSerovalJson(body.s)) {
      if (reflect) reflectPage(reflect, page);
      return (await codec()).fromJSON(body.s);
    }
    if (isRedirectJson(body)) {
      const target = new URL(body.redirect, endpoint);
      if (reflect && withoutHash(target) === withoutHash(new URL(location.href))) {
        return reflectPage(reflect, page) ? never() : undefined;
      }
      location.assign(target);
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
