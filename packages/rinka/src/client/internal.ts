import { isSeeding } from "../shared/scope.ts";

/** `await` する値を受け取り、`await` させる値を返す関門を表す。 */
export interface Gate {
  <T>(value: T): T | Promise<never>;
  /** `for await` で反復する値を受け取り、反復させる値を返す。 */
  iterate<T>(source: T): T | AsyncIterable<never>;
}

/** 最初の値を返さない async iterable である。 */
const silent: AsyncIterable<never> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
};

const pass: Gate = Object.assign(<T>(value: T) => value, { iterate: <T>(source: T) => source });
const halt: Gate = Object.assign(() => new Promise<never>(() => {}), { iterate: () => silent });

/** シード中に呼び出したら、値の代わりに解決しない Promise を返す関門を返す。それ以外では、値をそのまま返す関門を返す。 */
export const takeGate = (): Gate => (isSeeding() ? halt : pass);
