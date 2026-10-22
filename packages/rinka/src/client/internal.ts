import { isSeeding } from "../shared/scope.ts";

/** `await` する値を受け取り、`await` させる値を返す関数を表す。 */
export type Gate = <T>(value: T) => T | Promise<never>;

const pass: Gate = (value) => value;
const halt: Gate = () => new Promise<never>(() => {});

/** シード中に呼び出したら、値の代わりに解決しない Promise を返す関門を返す。それ以外では、値をそのまま返す関門を返す。 */
export const takeGate = (): Gate => (isSeeding() ? halt : pass);
