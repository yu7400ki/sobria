/** 値を受け取る。 */
export declare function same(value: Local): void;
/** 両方の環境で使用する型を表す。 */
interface Local {
  readonly name: string;
}
/** ブラウザで実行する。 */
export declare const differ: () => void;
/** ブラウザにだけある値である。 */
export declare const onlyClient: number;
export { Hono } from "hono";
