import type { SerovalJSON, SerovalNode } from "seroval";

import { withBase } from "./base.ts";
import { serverJsxNodes } from "./nodes.ts";
import { isPlainObject } from "./objects.ts";
import { serverFnRefOf } from "./server-fn.ts";

/** RPC のレスポンスで、値の形式を示すヘッダーの名前。 */
export const wireHeader = "x-sobria-wire";

/**
 * `wireHeader` に設定する値。`rpc` は sobria が構築したレスポンスを示す。
 * `stream` は、本文が改行で区切った `StreamLine` の JSON の行であることを示す。
 */
export const wireFormat = { rpc: "rpc", stream: "stream" } as const;

/** サーバー関数のレスポンスで移動先を伝える JSON を表す。`redirect` は `Location` の値で、相対の URL はリクエストの URL を基準にする。 */
export interface RedirectJson {
  readonly redirect: string;
}

/** `value` が、移動先を伝える JSON かどうかを返す。 */
export const isRedirectJson = (value: unknown): value is RedirectJson =>
  isPlainObject(value) && "redirect" in value && typeof value.redirect === "string";

/** GET の RPC で入力を送るクエリの名前を表す。`json` は素の JSON を、`seroval` は seroval の JSON の形式を示す。 */
export const rpcQuery = { json: "d", seroval: "s" } as const;

/** sobria が処理する、アプリの中のパスの接頭辞である。 */
const INTERNAL_PREFIX = "/_sobria/";

/** sobria が処理する URL のパスの接頭辞を、アプリを配置するパスを前置して返す。 */
export const internalUrlPrefix = (): string => withBase(INTERNAL_PREFIX);

/** サーバー関数のエンドポイントの URL のパスの接頭辞を、アプリを配置するパスを前置して返す。 */
export const rpcUrlPrefix = (): string => `${internalUrlPrefix()}fn/`;

/** ID が `id` のサーバー関数のエンドポイントの URL のパスを、アプリを配置するパスを前置して返す。 */
export const rpcPath = (id: string): string => rpcUrlPrefix() + encodeURIComponent(id);

/** `404.html` に書き出すページの、アプリの中のパスである。 */
export const notFoundPrerenderPath = `${INTERNAL_PREFIX}not-found`;

/** フォームの送信で、宛先のサーバー関数の ID を値に持つ欄の名前である。 */
export const submissionField = "_sobria_fn";

/** sobria が構築した RPC のレスポンスのうち、値を返すときの本文を表す。 */
export type RpcBody = { ok: unknown } | { s: SerovalJSON };

/**
 * ストリームのレスポンスの 1 行を表す。値の行は `RpcBody` で、最後の行は、終わったことを示す `{ end: true }`、移動先を伝える JSON、
 * 失敗したことを示す `{ error: true }` のどれかである。
 */
export type StreamLine = RpcBody | { end: true } | RedirectJson | { error: true };

/** `line` を、ストリームのレスポンスの 1 行の文字列にする。改行は含めない。 */
export const streamLineText = (line: StreamLine): string => JSON.stringify(line);

/** `streamLineText` で作成した行の文字列 `text` が、`{ end: true }` か移動先を伝える行かどうかを返す。 */
export const isEndOrRedirectLineText = (text: string): boolean =>
  text === endLineText || text.startsWith('{"redirect":');

const endLineText = streamLineText({ end: true });

/** 受け取った文字列をつなげて改行で区切り、改行を除いた 1 行ずつを送り出す TransformStream を返す。最後の改行より後の文字列は送り出さない。 */
export function splitLines(): TransformStream<string, string> {
  let rest = "";
  return new TransformStream({
    transform: (chunk, controller) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) controller.enqueue(line);
    },
  });
}

/** `value` が、seroval の JSON の形式の外側の形を持つかどうかを返す。 */
export const isSerovalJson = (value: unknown): value is SerovalJSON =>
  typeof value === "object" &&
  value !== null &&
  "t" in value &&
  typeof value.t === "object" &&
  value.t !== null &&
  "f" in value &&
  typeof value.f === "number" &&
  "m" in value &&
  Array.isArray(value.m);

/** `JSON.parse(JSON.stringify(value))` が `value` と同じ値を返すかどうかを返す。 */
export const isJson = (value: unknown): boolean => isJsonBelow(value, new Set());

/** `value` が JSON で表せるかどうかを返す。`ancestors` は、`value` を含む配列とオブジェクトであり、`value` がそのどれかなら偽を返す。 */
function isJsonBelow(value: unknown, ancestors: Set<object>): boolean {
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value) && !Object.is(value, -0);
    case "object": {
      if (value === null) return true;
      if (ancestors.has(value)) return false;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) if (!(i in value)) return false;
      } else if (!isPlainObject(value)) return false;
      ancestors.add(value);
      const json = Object.values(value).every((item) => isJsonBelow(item, ancestors));
      ancestors.delete(value);
      return json;
    }
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      return false;
  }
}

const builtins = [Date, RegExp, Map, Set, ArrayBuffer, DataView];

/**
 * seroval でシリアライズできない値を `value` の中から探索し、`path` に続けてその値の位置を示すエラーを投げる。
 * `serverFns` が真なら、ID とメソッドを保持するサーバー関数を、シリアライズできる値として扱う。
 */
export function checkSerializable(value: unknown, path: string, serverFns: boolean): void {
  check(value, path, serverFns, new Set());
}

function check(value: unknown, path: string, serverFns: boolean, seen: Set<object>): void {
  if (typeof value === "object" && value !== null && serverJsxNodes.has(value)) {
    const hint = serverFns ? "JSX は、スロットの props で渡してください。" : "";
    throw new Error(`${path} は JSX なので、シリアライズできません。${hint}`);
  }
  if (typeof value === "function" && !(serverFns && serverFnRefOf(value))) {
    const hint = serverFns ? "サーバーから要素に渡せる関数は、サーバー関数だけです。" : "";
    throw new Error(`${path} は関数なので、シリアライズできません。${hint}`);
  }
  if (typeof value === "symbol")
    throw new Error(`${path} は symbol なので、シリアライズできません。`);
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  const next = (item: unknown, at: string) => check(item, at, serverFns, seen);
  if (Array.isArray(value)) {
    value.forEach((item: unknown, i) => next(item, `${path}[${i}]`));
    return;
  }
  if (value instanceof Map) {
    for (const [key, item] of value as Map<unknown, unknown>) {
      next(key, `${path} のキー`);
      next(item, `${path}.get(${String(key)})`);
    }
    return;
  }
  if (value instanceof Set) {
    for (const item of value as Set<unknown>) next(item, `${path} の要素`);
    return;
  }
  if (ArrayBuffer.isView(value) || builtins.some((type) => value instanceof type)) return;
  if (value instanceof Error) {
    throw new Error(
      `${path} は Error なので、送信できません。サーバーのスタックトレースが含まれるためです。{ message } のようなオブジェクトにして送信してください。`,
    );
  }
  if (value instanceof Promise) {
    throw new Error(
      `${path} は Promise なので、シリアライズできません。await してから渡してください。`,
    );
  }
  if (!isPlainObject(value)) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "クラス";
    throw new Error(
      `${path} は ${name} のインスタンスなので、シリアライズできません。プレーンなオブジェクト、配列、Date、Map、Set などを送信してください。`,
    );
  }
  for (const [key, item] of Object.entries(value)) next(item, `${path}.${key}`);
}

/**
 * `<form>` の props を返す。`action` がサーバー関数なら、`action` を除き、`method` を `post` に、`enctype` を `multipart/form-data` にし、
 * `_sobria_fn` の名前でサーバー関数の ID を値に持つ hidden input を `create` で作成し、子の先頭に加える。`enctype` を記述していれば、その値を使用する。
 */
export function formProps(
  props: Record<string, unknown>,
  create: (tag: string, props: Record<string, unknown>) => unknown,
): Record<string, unknown> {
  const ref = serverFnRefOf(props.action);
  if (!ref) return props;
  const { action: _action, enctype = "multipart/form-data", ...rest } = props;
  return {
    ...rest,
    method: "post",
    enctype,
    children: [
      create("input", { type: "hidden", name: submissionField, value: ref.id }),
      props.children,
    ],
  };
}

/** multipart で送る RPC の入力で、Blob を参照に置き換えた入力の seroval の JSON を値に持つ部分の名前である。Blob は、出現した順に `0`、`1`、… の部分に入れる。 */
export const rpcInputPart = "input";

/** RPC の入力の Blob を、multipart の番号の部分への参照にする seroval のプラグインの名前である。 */
export const blobPluginTag = "sobria/blob";

/** `blobPluginTag` のプラグインが作成する、multipart の番号の部分への参照のノードを表す。 */
export type BlobNode = { readonly index: SerovalNode };
