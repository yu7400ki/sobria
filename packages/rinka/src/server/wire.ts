import { createPlugin, fromJSON, serialize, toJSON, type SerovalNode } from "seroval";

import { serverFnRefOf, type ServerFnRef } from "../shared/server-fn.ts";
import {
  blobPluginTag,
  checkSerializable,
  isJson,
  isSerovalJson,
  type RpcBody,
} from "../shared/wire.ts";
import { serverFnCall } from "./bootstrap.ts";
import { replacedOnPage } from "./html.ts";

function refuseError(): never {
  throw new Error("Error は送信できません。");
}

/** Error を拒否する seroval のプラグイン。 */
const refuseErrors = createPlugin<Error, never>({
  tag: "rinka/refuse-error",
  test: (value) => value instanceof Error,
  parse: { sync: refuseError, async: refuseError, stream: refuseError },
  serialize: refuseError,
  deserialize: refuseError,
});

/** seroval のプラグインが扱う、サーバー関数の ID とメソッドのノードを表す。 */
type RefNode = { readonly id: SerovalNode; readonly method: SerovalNode };

/** サーバー関数の ID とメソッドを返す。サーバー関数でなければ例外を投げる。 */
function refOf(value: unknown): ServerFnRef {
  const ref = serverFnRefOf(value);
  if (!ref) throw new TypeError("サーバー関数ではありません。");
  return ref;
}

/** ID とメソッドを保持するサーバー関数を、`$rinka.f` の式にする seroval のプラグイン。 */
const serverFns = createPlugin<(...args: never[]) => unknown, RefNode>({
  tag: "rinka/server-fn",
  test: (value) => serverFnRefOf(value) !== undefined,
  parse: {
    sync: (value, ctx) => {
      const { id, method } = refOf(value);
      return { id: ctx.parse(id), method: ctx.parse(method) };
    },
  },
  serialize: (node, ctx) => serverFnCall(ctx.serialize(node.id), ctx.serialize(node.method)),
  deserialize: refuseError,
});

/** `run` が失敗したときだけ `value` を走査し、送信できない値の位置を示すエラーを投げる。`allowServerFns` は `checkSerializable` に渡す。 */
function withPath<T>(run: () => T, value: unknown, path: string, allowServerFns: boolean): T {
  try {
    return run();
  } catch (error) {
    checkSerializable(value, path, allowServerFns);
    throw error;
  }
}

/** ページのスクリプトに埋め込む、`value` を作成する JS の式を返す。U+FFFD に置き換わる文字は、`\u` のエスケープにする。 */
export function toScript(value: unknown, path: string): string {
  return withPath(
    () =>
      serialize(value, { plugins: [refuseErrors, serverFns] }).replace(
        replacedOnPage,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ),
    value,
    path,
    true,
  );
}

/** サーバー関数の戻り値から、RPC のレスポンスの本文を作成する。 */
export function toRpcBody(value: unknown): RpcBody {
  if (isJson(value)) return { ok: value };
  return {
    s: withPath(
      () => toJSON(value, { plugins: [refuseErrors] }),
      value,
      "サーバー関数の戻り値",
      false,
    ),
  };
}

/** seroval のプラグインが扱う、multipart の番号の部分への参照のノードを表す。 */
type BlobNode = { readonly index: SerovalNode };

/** multipart の番号の部分への参照を、`blobs` のその番号の値にする seroval のプラグインを返す。`blobs` に無い番号を参照したら例外を投げる。 */
const blobsOf = (blobs: readonly Blob[]) =>
  createPlugin<Blob, BlobNode>({
    tag: blobPluginTag,
    test: () => false,
    parse: { sync: refuseError, async: refuseError, stream: refuseError },
    serialize: refuseError,
    deserialize: (node, ctx) => {
      const index = ctx.deserialize(node.index);
      const blob = typeof index === "number" ? blobs[index] : undefined;
      if (blob === undefined) throw new TypeError("参照した部分がありません。");
      return blob;
    },
  });

/**
 * seroval の JSON の形式の文字列で送られた RPC の入力を読む。Blob の参照は、`blobs` のその番号の値にする。関数の参照は復元しない。
 * 形式に合わないときと、`blobs` に無い番号を参照したときは、例外を投げる。
 */
export function fromRpcInput(text: string, blobs: readonly Blob[] = []): unknown {
  const json: unknown = JSON.parse(text);
  if (!isSerovalJson(json)) throw new TypeError("seroval の JSON の形式ではありません。");
  return fromJSON(json, { plugins: [blobsOf(blobs)] });
}
