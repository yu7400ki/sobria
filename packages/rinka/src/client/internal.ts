import { isSeeding } from "../shared/scope.ts";

/** `await` する値を受け取り、`await` させる値を返す関数を表す。 */
export type Gate = <T>(value: T) => T | Promise<never>;

const pass: Gate = (value) => value;
const halt: Gate = () => new Promise<never>(() => {});

/**
 * async 関数の開始時点で呼び出し、その関数の `await` の値を渡す関数を返す。
 * シード中に呼び出したら、値の代わりに解決しない Promise を返す関数を返す。
 */
export const takeGate = (): Gate => (isSeeding() ? halt : pass);
