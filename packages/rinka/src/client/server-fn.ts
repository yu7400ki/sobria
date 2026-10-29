import { isPlainObject } from "../shared/objects.ts";
import { PAGE_HEADER } from "../shared/refresh.ts";
import { isSeeding } from "../shared/scope.ts";
import type { CallOptions, ServerFnMethod } from "../shared/server-fn.ts";
import { ServerFnError, withServerFnRef } from "../shared/server-fn.ts";
import {
  isJson,
  isRedirectJson,
  isSerovalJson,
  rpcInputPart,
  rpcPath,
  rpcQuery,
  splitLines,
  wireFormat,
  wireHeader,
} from "../shared/wire.ts";
import { redirected, reflectPage, startRewrite, type Reflect } from "./refresh.ts";

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
 * 入力に Blob があれば、multipart で送る。GET の入力に Blob があれば、送信せずに TypeError を投げる。
 * `x-rinka-wire: stream` のレスポンスでは、行の値を yield する async iterable を返す。
 * 2xx 以外のレスポンスは `ServerFnError` として投げ、rinka が組み立てていない 2xx のレスポンスは Response のまま返す。
 */
export function serverFn(id: string, method: ServerFnMethod): RpcFn {
  const call: RpcFn = async (input, { signal, headers, refresh = true }: CallOptions = {}) => {
    if (isSeeding()) return never();
    const plain = input === undefined || isJson(input);
    const converted = plain ? undefined : (await codec()).toRpcInput(input);
    const blobs = converted?.blobs ?? [];
    if (method === "GET" && blobs.length > 0) {
      throw new TypeError("GET のサーバー関数の入力には、File と Blob を含められません。");
    }
    const encoded =
      input === undefined ? undefined : JSON.stringify(converted ? converted.json : input);
    const sent = new Headers(headers);
    const reflect = method !== "GET" && refresh ? startRewrite() : undefined;
    if (reflect) sent.set(PAGE_HEADER, location.href);
    let url = rpcPath(id);
    let body: string | FormData | undefined;
    if (method === "GET") {
      if (encoded !== undefined) {
        url += `?${plain ? rpcQuery.json : rpcQuery.seroval}=${encodeURIComponent(encoded)}`;
      }
    } else if (blobs.length > 0 && encoded !== undefined) {
      const parts = new FormData();
      parts.append(rpcInputPart, encoded);
      blobs.forEach((blob, index) => parts.append(String(index), blob));
      body = parts;
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
    return read(response, new URL(url, document.baseURI), reflect);
  };
  return withServerFnRef(call, { id, method });
}

/** 起動スクリプトの `$rinka.c` に `serverFn` を登録する。起動スクリプトを読み込んでいないページでは、何もしない。 */
export function installRpc(): void {
  if (globalThis.$rinka) globalThis.$rinka.c = serverFn;
}

/**
 * RPC の `response` から値を返す。`reflect` があれば、値を返す前に、レスポンスの `page` を `reflect` で反映する。ストリームのレスポンスでは、`streamed` の async iterable を返す。
 * 移動先を伝える JSON は、`endpoint` を基準に解決する。`reflect` があり、移動先が現在のページなら `page` を反映し、それ以外では移動先に移動する。
 */
async function read(
  response: Response,
  endpoint: URL,
  reflect: Reflect | undefined,
): Promise<unknown> {
  const built = response.headers.get(wireHeader) === wireFormat.rpc;
  if (!response.ok) throw new ServerFnError(response, await parsed(response.clone()));
  if (response.headers.get(wireHeader) === wireFormat.stream) {
    return streamed(response, endpoint, reflect !== undefined);
  }
  if (!built) return response;
  const body: unknown = await response.json();
  if (typeof body === "object" && body !== null) {
    const page = "page" in body ? body.page : undefined;
    const decoded = await decode(body);
    if (decoded) {
      if (reflect) reflectPage(reflect, page);
      return decoded.value;
    }
    if (isRedirectJson(body))
      return redirected(body, page, endpoint, reflect) ? never() : undefined;
  }
  throw new TypeError("サーバー関数のレスポンスの本文が、rinka の RPC の形式ではありません。");
}

/**
 * ストリームの `response` から値の行を読み、その値を、行を受信するたびに yield する。`{ end: true }` の行を受信したら、`refresh` が真なら `page` を反映して終わる。
 * 移動先を伝える行は、`{ redirect }` の本文と同じく、`refresh` が真で移動先が現在のページなら `page` を反映して終わる。
 * それ以外の移動先と、ページを読み込み直すときは、移動を始めた後に反復を止めたままにする。
 * `page` は、終わりの行を受信した時点で始めた描き直しとして反映する。
 * `{ error: true }` の行を受信したら、ステータスが 500 の `ServerFnError` を投げる。
 * `return()` を呼ぶと、次の行を待っているときも、すぐに本文の読み取りを中止する。待っている `next()` は終わりを返す。
 */
function streamed(response: Response, endpoint: URL, refresh: boolean): AsyncIterable<unknown> {
  const reader = (response.body ?? new ReadableStream<Uint8Array<ArrayBuffer>>())
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(splitLines())
    .getReader();
  let cancelled = false;
  const values = (async function* (): AsyncGenerator<unknown, void> {
    try {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop
        const { done, value: text } = await reader.read();
        if (done) {
          if (cancelled) return;
          break;
        }
        const parsedLine: unknown = JSON.parse(text);
        const line = isPlainObject(parsedLine) ? parsedLine : {};
        const page = "page" in line ? line.page : undefined;
        // oxlint-disable-next-line no-await-in-loop
        const decoded = await decode(line);
        if (decoded) {
          yield decoded.value;
        } else if ("end" in line) {
          if (refresh) reflectPage(startRewrite(), page);
          return;
        } else if (isRedirectJson(line)) {
          // oxlint-disable-next-line no-await-in-loop
          if (redirected(line, page, endpoint, refresh ? startRewrite() : undefined)) await never();
          return;
        } else if ("error" in line) {
          throw new ServerFnError(response, null, 500);
        } else {
          throw new TypeError("サーバー関数のストリームの行が、rinka の形式ではありません。");
        }
      }
      throw new TypeError("サーバー関数のストリームが、終わりを伝える行の前に途切れました。");
    } finally {
      await reader.cancel().catch(() => {});
    }
  })();
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => values.next(),
      return: async () => {
        cancelled = true;
        await reader.cancel().catch(() => {});
        return values.return();
      },
    }),
  };
}

/** `body` が `{ ok }` か `{ s }` なら、その値を `value` に持つオブジェクトを返し、そうでなければ `undefined` を返す。 */
async function decode(body: object): Promise<{ readonly value: unknown } | undefined> {
  if ("ok" in body) return { value: body.ok };
  if ("s" in body && isSerovalJson(body.s)) return { value: (await codec()).fromJSON(body.s) };
  return undefined;
}

/** レスポンスの本文を JSON として読む。JSON でなければ `null` を返す。 */
async function parsed(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}
