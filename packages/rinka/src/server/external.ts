import type { External } from "../shared/signals.ts";

/** `getServerSnapshot` の値を返す関数を返す。`getServerSnapshot` が無ければ、エラーを投げる。 */
export const external: External = (_subscribe, _getSnapshot, getServerSnapshot) => {
  if (!getServerSnapshot) {
    throw new Error(
      "[rinka] サーバーで external を使用するには、getServerSnapshot を指定してください。",
    );
  }
  return getServerSnapshot;
};
