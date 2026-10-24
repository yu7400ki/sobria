/** 値を受け取る。 */
export declare function same(value: Local): void;
/** 両方の環境で使用する型を表す。 */
interface Local {
  readonly name: string;
}
/** 何も実行せずに戻る。 */
export declare const differ: () => void;
export { Hono } from "hono";
