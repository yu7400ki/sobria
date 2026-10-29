import { createPlugin, toJSON, type SerovalJSON } from "seroval";

import { blobPluginTag, type BlobNode } from "../shared/wire.ts";

export { fromJSON } from "seroval";

function unused(): never {
  throw new Error("Blob の参照は、RPC の入力の送信でだけ作成します。");
}

/** RPC の入力 `value` の seroval の JSON と、その中の Blob を出現した順に返す。JSON の中の Blob は、その順の番号への参照にする。 */
export function toRpcInput(value: unknown): { json: SerovalJSON; blobs: Blob[] } {
  const blobs: Blob[] = [];
  const blobRefs = createPlugin<Blob, BlobNode>({
    tag: blobPluginTag,
    test: (item) => item instanceof Blob,
    parse: { sync: (blob, ctx) => ({ index: ctx.parse(blobs.push(blob) - 1) }) },
    serialize: unused,
    deserialize: unused,
  });
  return { json: toJSON(value, { plugins: [blobRefs] }), blobs };
}
