/**
 * サーバーの `internals` に代入された値 `recorded` のうち、`role` と ARIA のプロパティの文字列の値を、属性の名前と値の組にして返す。
 * 属性の名前は、プロパティの名前の `aria` より後を小文字にして、`aria-` を前に付けた名前である。例えば、`ariaValueNow` は `aria-valuenow` になる。
 */
export function ariaAttributes(recorded: object): [name: string, value: string][] {
  return Object.entries(recorded).flatMap(([key, value]): [string, string][] => {
    if (typeof value !== "string") return [];
    if (key === "role") return [["role", value]];
    if (!/^aria[A-Z]/.test(key)) return [];
    return [[`aria-${key.slice(4).toLowerCase()}`, value]];
  });
}
