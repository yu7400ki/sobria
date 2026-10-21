/** 真偽値を `"true"` か `"false"` の文字列で出力する、列挙型の属性の名前。 */
const enumerated: ReadonlySet<string> = new Set(["draggable", "spellcheck", "contenteditable"]);

/**
 * 属性に出力する値を返す。出力しない値なら `null` を返す。
 * `aria-*` と列挙型の属性の真偽値は `"true"` か `"false"` にし、`class` のオブジェクトは値が真のキーを空白で区切る。ほかの値は文字列に変換する。
 */
export function attributeValue(name: string, value: unknown): string | null {
  if (typeof value === "boolean" && (name.startsWith("aria-") || enumerated.has(name))) {
    return String(value);
  }
  if (value === true) return "";
  if (value === false || value === null || value === undefined) return null;
  if (name === "class" && typeof value === "object") {
    const names = Object.entries(value)
      .filter(([, on]) => Boolean(on))
      .map(([key]) => key);
    return names.length === 0 ? null : names.join(" ");
  }
  // oxlint-disable-next-line typescript/no-base-to-string
  return String(value);
}

/** JSX の props の名前から、出力する属性の名前を返す。`key` は `data-ok` になる。 */
export const attributeName = (name: string): string => (name === "key" ? "data-ok" : name);
