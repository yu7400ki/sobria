declare const methods: readonly ["GET", "POST"];
/** メソッドを表す。 */
type Method = (typeof methods)[number];
/**
 * 内部の値を表す。
 * @internal
 */
interface Hidden {
  readonly secret: Detail;
}
/** 内部の値の詳細を表す。 */
interface Detail {
  readonly value: string;
}
/** `<head>` に {x} & y を出力する。 */
export interface Uses {
  readonly hidden: Hidden;
}
/** 1 つ目の形である。 */
export declare function overload(value: string): string;
/** 2 つ目の形である。 */
export declare function overload(value: number): number;
export type { Method };
