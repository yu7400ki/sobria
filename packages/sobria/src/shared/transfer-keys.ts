/** ホストの Shadow DOM の中の後送りの境界を、すべて送り終えたことを表す値のキーである。 */
export const BOUNDARIES_KEY = "@b";

/** 属性の文字列から元の値に戻せない props の値を送るキーである。 */
export const PROPS_KEY = "@p";

/** 描き直しで、ページにある要素に設定する props の値を送るキーである。 */
export const REFRESH_PROPS_KEY = "@r";

/** 子要素のホストの ID を送るキーの接頭辞である。 */
const CHILD_PREFIX = "@c:";

/** 呼び出し箇所と回数のキーが `key` の子要素について、そのホストの ID を送るキーを返す。 */
export const childKey = (key: string): string => `${CHILD_PREFIX}${key}`;

/** `key` が、子要素のホストの ID を送るキーかどうかを返す。 */
export const isChildKey = (key: string): boolean => key.startsWith(CHILD_PREFIX);

/** `key` が、sobria が値の受け渡しのために予約したキーかどうかを返す。予約したキーは `@` で始まる。 */
export const isReservedKey = (key: string): boolean => key.startsWith("@");
