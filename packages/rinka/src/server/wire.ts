import { createPlugin, fromJSON, serialize, toJSON, type SerovalJSON } from "seroval";

import { checkSerializable, isJson } from "../shared/wire.ts";

function refuseError(): never {
  throw new Error("Error は送信できません。");
}

/** Error を拒否する seroval のプラグイン。Error は、1 回のシリアライズの中で検出する。 */
const refuseErrors = createPlugin<Error, never>({
  tag: "rinka/refuse-error",
  test: (value) => value instanceof Error,
  parse: { sync: refuseError, async: refuseError, stream: refuseError },
  serialize: refuseError,
  deserialize: refuseError,
});

/** `run` が失敗したときだけ `value` をたどり、送れない値の位置を示すエラーを投げる。 */
function withPath<T>(run: () => T, value: unknown, path: string): T {
  try {
    return run();
  } catch (error) {
    checkSerializable(value, path);
    throw error;
  }
}

/** ページのスクリプトに埋め込む、`value` を作る JS の式を返す。 */
export function toScript(value: unknown, path: string): string {
  return withPath(() => serialize(value, { plugins: [refuseErrors] }), value, path);
}

/** サーバー関数の戻り値から、RPC のレスポンスの本文を作る。 */
export function toRpcBody(value: unknown): { ok: unknown } | { s: SerovalJSON } {
  if (isJson(value)) return { ok: value };
  return {
    s: withPath(() => toJSON(value, { plugins: [refuseErrors] }), value, "サーバー関数の戻り値"),
  };
}

/** seroval の JSON の形式で送られた RPC の入力を読む。プラグインを使わないので、関数の参照は復元しない。 */
export function fromRpcInput(json: SerovalJSON): unknown {
  return fromJSON(json);
}
