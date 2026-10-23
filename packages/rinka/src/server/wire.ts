import { createPlugin, fromJSON, serialize, toJSON, type SerovalJSON } from "seroval";

import { checkSerializable, isJson, type RpcBody } from "../shared/wire.ts";

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

/** `run` が失敗したときだけ `value` を走査し、送信できない値の位置を示すエラーを投げる。 */
function withPath<T>(run: () => T, value: unknown, path: string): T {
  try {
    return run();
  } catch (error) {
    checkSerializable(value, path);
    throw error;
  }
}

/** `value` を、`<script>` の中に埋め込める JSON にする。 */
export const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replaceAll("<", "\\u003c");

/** ページのスクリプトに埋め込む、`value` を作成する JS の式を返す。 */
export function toScript(value: unknown, path: string): string {
  return withPath(() => serialize(value, { plugins: [refuseErrors] }), value, path);
}

/** サーバー関数の戻り値から、RPC のレスポンスの本文を作成する。 */
export function toRpcBody(value: unknown): RpcBody {
  if (isJson(value)) return { ok: value };
  return {
    s: withPath(() => toJSON(value, { plugins: [refuseErrors] }), value, "サーバー関数の戻り値"),
  };
}

/** seroval の JSON の形式で送られた RPC の入力を読む。関数の参照は復元しない。 */
export function fromRpcInput(json: SerovalJSON): unknown {
  return fromJSON(json);
}
