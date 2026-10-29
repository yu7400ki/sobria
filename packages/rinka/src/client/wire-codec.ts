import { createPlugin, SerovalParserError, toJSON, type SerovalJSON } from "seroval";

import { blobPluginTag, type BlobNode } from "../shared/wire.ts";

export { fromJSON } from "seroval";

function unused(): never {
  throw new Error("このプラグインは、RPC の入力の送信でだけ使用します。");
}

/** RPC の入力に含めると、TypeError を投げる Web API のクラスである。 */
const unsendable = [FormData, URLSearchParams, Headers];

/** `unsendable` のインスタンスに一致し、parse で TypeError を投げるプラグインである。 */
const rejectUnsendable = createPlugin<object, never>({
  tag: "rinka/unsendable",
  test: (item) => unsendable.some((type) => item instanceof type),
  parse: {
    sync: (item) => {
      const name = unsendable.find((type) => item instanceof type)?.name;
      throw new TypeError(
        `サーバー関数の入力には、${name} を含められません。プレーンなオブジェクトにして渡してください。`,
      );
    },
  },
  serialize: unused,
  deserialize: unused,
});

/**
 * RPC の入力 `value` の seroval の JSON と、その中の Blob を出現した順に返す。JSON の中の Blob は、その順の番号への参照にする。
 * `value` が FormData、URLSearchParams、Headers を含むときは、TypeError を投げる。
 */
export function toRpcInput(value: unknown): { json: SerovalJSON; blobs: Blob[] } {
  const blobs: Blob[] = [];
  const blobRefs = createPlugin<Blob, BlobNode>({
    tag: blobPluginTag,
    test: (item) => item instanceof Blob,
    parse: { sync: (blob, ctx) => ({ index: ctx.parse(blobs.push(blob) - 1) }) },
    serialize: unused,
    deserialize: unused,
  });
  try {
    return { json: toJSON(value, { plugins: [blobRefs, rejectUnsendable] }), blobs };
  } catch (error) {
    // seroval は、プラグインが投げた値を cause に持つ SerovalParserError を投げる。
    throw error instanceof SerovalParserError && error.cause instanceof TypeError
      ? error.cause
      : error;
  }
}
