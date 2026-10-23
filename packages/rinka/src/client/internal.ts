import { isSeeding } from "../shared/scope.ts";

export { registerElement as defineElement } from "./element.ts";
import { listenForms } from "./form.ts";
import { installRpc } from "./server-fn.ts";

export { serverFn } from "./server-fn.ts";

installRpc();
if (globalThis.$rinka) listenForms();

/** `await` する値を受け取り、シード中なら解決しない Promise を、それ以外では値をそのまま返す関数を表す。 */
export interface SeedingStop {
  <T>(value: T): T | Promise<never>;
  /** `for await` で反復する値を受け取り、反復させる値を返す。 */
  iterate<T>(source: T): T | AsyncIterable<never>;
}

/** 最初の値を返さない async iterable である。 */
const silent: AsyncIterable<never> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
};

const pass: SeedingStop = Object.assign(<T>(value: T) => value, {
  iterate: <T>(source: T) => source,
});
const halt: SeedingStop = Object.assign(() => new Promise<never>(() => {}), {
  iterate: () => silent,
});

/** 呼び出した時点でシード中なら、値の代わりに解決しない Promise を返す関数を返す。シード中でなければ、値をそのまま返す関数を返す。 */
export const stopIfSeeding = (): SeedingStop => (isSeeding() ? halt : pass);
