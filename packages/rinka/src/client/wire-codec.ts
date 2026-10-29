import { createPlugin, toJSON, type SerovalJSON } from "seroval";

import { blobPluginTag, type BlobNode } from "../shared/wire.ts";

export { fromJSON } from "seroval";

function unused(): never {
  throw new Error("このプラグインは、RPC の入力の送信でだけ使用します。");
}

/** RPC の入力に含めると、TypeError を投げる Web API のクラスである。 */
const unsendable = [FormData, URLSearchParams, Headers];

/**
 * RPC の入力 `value` の seroval の JSON と、その中の Blob を出現した順に返す。JSON の中の Blob は、その順の番号への参照にする。
 * `value` が FormData、URLSearchParams、Headers を含むときは、TypeError を投げる。
 */
export function toRpcInput(value: unknown): { json: SerovalJSON; blobs: Blob[] } {
  const blobs: Blob[] = [];
  let rejected: string | undefined;
  const blobRefs = createPlugin<Blob, BlobNode>({
    tag: blobPluginTag,
    test: (item) => item instanceof Blob,
    parse: { sync: (blob, ctx) => ({ index: ctx.parse(blobs.push(blob) - 1) }) },
    serialize: unused,
    deserialize: unused,
  });
  const unsendableNames = createPlugin<object, Record<string, never>>({
    tag: "rinka/unsendable",
    test: (item) => unsendable.some((type) => item instanceof type),
    parse: {
      sync: (item) => {
        rejected ??= unsendable.find((candidate) => item instanceof candidate)?.name;
        return {};
      },
    },
    serialize: unused,
    deserialize: unused,
  });
  const json = toJSON(value, { plugins: [blobRefs, unsendableNames] });
  if (rejected !== undefined) {
    throw new TypeError(
      `サーバー関数の入力には、${rejected} を含められません。プレーンなオブジェクトにして渡してください。`,
    );
  }
  return { json, blobs };
}
