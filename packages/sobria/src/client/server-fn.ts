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
 * GET 以外では、呼び出しのオプションの `refresh` が `false` でなければ、現在のページの URL を `x-sobria-page` で送る。描き直しの新旧の順序は、呼び出した時点で決まる。
 * sobria が組み立てたレスポンスなら、`{ ok }` と `{ s }` の値を返す。`x-sobria-page` を送ったときは、値を返す前にレスポンスの `page` を反映し、`page` が描き直しの JSON でなければページを読み込み直す。
 * `{ redirect }` は、`x-sobria-page` を送り、移動先が現在のページ（hash を除く）なら、`page` を反映して `undefined` を返す。`page` が描き直しの JSON でなければ、ページを読み込み直す。
 * それ以外の `{ redirect }` では、その URL に移動する。`{ redirect }` でページを読み込み直すときと移動するときは、返す Promise は解決しない。
 * 入力は `rpcRequest` の形式で送る。
 * `x-sobria-wire: stream` のレスポンスでは、行の値を yield する async iterable を返す。
 * 2xx 以外のレスポンスは `ServerFnError` として投げ、sobria が組み立てていない 2xx のレスポンスは Response のまま返す。
 */
export function serverFn(id: string, method: ServerFnMethod): RpcFn {
  const call: RpcFn = async (input, { signal, headers, refresh = true }: CallOptions = {}) => {
    if (isSeeding()) return never();
    const reflect = method !== "GET" && refresh ? startRewrite() : undefined;
    const sent = new Headers(headers);
    if (reflect) sent.set(PAGE_HEADER, location.href);
    const request = await rpcRequest(id, method, input);
    for (const [name, value] of Object.entries(request.headers)) sent.set(name, value);
    const response = await fetch(request.url, {
      method,
      headers: sent,
      ...(request.body !== undefined && { body: request.body }),
      ...(signal !== undefined && { signal }),
    });
    return read(response, new URL(request.url, document.baseURI), reflect);
  };
  return withServerFnRef(call, { id, method });
}

/** RPC のリクエストの URL、本文、本文の `Content-Type` のヘッダーを表す。 */
export interface RpcRequest {
  readonly url: string;
  readonly body?: string | FormData;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * ID が `id` のサーバー関数を `method` で呼び出すリクエストのうち、入力 `input` から決まる部分を返す。
 * 素の JSON で表せる入力は、GET では `?d=` に、POST では本文に入れる。
 * 素の JSON で表せない入力は、seroval の JSON の形式にする。GET では `?s=` に入れ、入力に Blob があれば TypeError で reject する。
 * POST では、seroval の JSON の形式を `input` の部分に、Blob をその番号の部分にした multipart にする。
 */
export async function rpcRequest(
  id: string,
  method: ServerFnMethod,
  input: unknown,
): Promise<RpcRequest> {
  const url = rpcPath(id);
  if (input === undefined) return { url, headers: {} };
  if (isJson(input)) {
    const json = JSON.stringify(input);
    return method === "GET"
      ? { url: `${url}?${rpcQuery.json}=${encodeURIComponent(json)}`, headers: {} }
      : { url, body: json, headers: { "content-type": "application/json" } };
  }
  return serovalRequest(url, method, (await codec()).toRpcInput(input));
}

/** URL が `url` のサーバー関数を `method` で呼び出すリクエストのうち、seroval の JSON の形式にした入力 `json` と、その Blob の `blobs` から決まる部分を返す。 */
function serovalRequest(
  url: string,
  method: ServerFnMethod,
  { json, blobs }: { readonly json: unknown; readonly blobs: readonly Blob[] },
): RpcRequest {
  const text = JSON.stringify(json);
  if (method === "GET") {
    if (blobs.length > 0) {
      throw new TypeError("GET のサーバー関数の入力には、File と Blob を含められません。");
    }
    return { url: `${url}?${rpcQuery.seroval}=${encodeURIComponent(text)}`, headers: {} };
  }
  const parts = new FormData();
  parts.append(rpcInputPart, text);
  blobs.forEach((blob, index) => parts.append(String(index), blob));
  return { url, body: parts, headers: {} };
}

/** 起動スクリプトの `$sobria.c` に `serverFn` を登録する。起動スクリプトを読み込んでいないページでは、何もしない。 */
export function installRpc(): void {
  if (globalThis.$sobria) globalThis.$sobria.c = serverFn;
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
  throw new TypeError("サーバー関数のレスポンスの本文が、sobria の RPC の形式ではありません。");
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
          throw new TypeError("サーバー関数のストリームの行が、sobria の形式ではありません。");
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
