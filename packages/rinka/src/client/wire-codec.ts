import { createPlugin, toJSON, type SerovalJSON } from "seroval";

import { blobPluginTag, type BlobNode } from "../shared/wire.ts";

export { fromJSON } from "seroval";

function unused(): never {
  throw new Error("このプラグインは、RPC の入力の送信でだけ使用します。");
}

/** seroval が型を保って記録する、反復可能なオブジェクトのクラスである。 */
const keptClasses: ReadonlySet<unknown> = new Set([
  Map,
  Set,
  String,
  Int8Array,
  Int16Array,
  Int32Array,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Uint8ClampedArray,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
]);

/** `item` のクラスを返す。`constructor` が関数でも undefined でもなければ、プロトタイプの `constructor` を返す。 */
function classOf(item: object): unknown {
  const constructor: unknown = item.constructor;
  if (constructor === undefined || typeof constructor === "function") return constructor;
  const prototype: unknown = Object.getPrototypeOf(item);
  return typeof prototype === "object" && prototype !== null ? prototype.constructor : undefined;
}

/** `item` が、seroval が反復可能なプレーンなオブジェクトとして記録するオブジェクトなら真を返す。 */
function isUnsendable(item: object): boolean {
  if (!(Symbol.iterator in item || Symbol.asyncIterator in item) || Array.isArray(item)) {
    return false;
  }
  const type = classOf(item);
  return type !== undefined && type !== Object && !keptClasses.has(type);
}

/** `item` の種類の名前を返す。クラスに名前があればその名前を、無ければ `Object.prototype.toString` のタグを返す。 */
function kindOf(item: object): string {
  const type = classOf(item);
  return typeof type === "function" && type.name !== ""
    ? type.name
    : Object.prototype.toString.call(item).slice("[object ".length, -1);
}

/**
 * RPC の入力 `value` の seroval の JSON と、その中の Blob を出現した順に返す。JSON の中の Blob は、その順の番号への参照にする。
 * `value` が、seroval が型を保てない反復可能なオブジェクト（FormData、URLSearchParams、Headers、ジェネレーター、反復可能なクラスのインスタンスなど）を含むときは、TypeError を投げる。
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
    test: (item) => typeof item === "object" && item !== null && isUnsendable(item),
    parse: {
      sync: (item) => {
        rejected ??= kindOf(item);
        return {};
      },
    },
    serialize: unused,
    deserialize: unused,
  });
  const json = toJSON(value, { plugins: [blobRefs, unsendableNames] });
  if (rejected !== undefined) {
    throw new TypeError(
      `サーバー関数の入力には、${rejected} を含められません。配列かプレーンなオブジェクトに変換して渡してください。`,
    );
  }
  return { json, blobs };
}
