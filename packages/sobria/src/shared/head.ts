import { attributeValue } from "./attributes.ts";

/** `<meta>` のキーになる属性のうち、`charset` 以外のものである。キーになる属性を複数持つ `<meta>` は、この順で最初の属性をキーにする。 */
const metaKeyNames = ["name", "property", "http-equiv"] as const;

/**
 * `<head>` のタグ `tag` のキーを返す。`read` は、属性の名前から値を返す。
 * `<title>`、`charset` を持つ `<meta>`、`rel` が `canonical` の `<link>` は、タグの種類がキーになる。ほかの `<meta>` は、キーになる属性の名前と値の組がキーになる。
 */
export function headKey(tag: string, read: (name: string) => unknown): string | undefined {
  const text = (name: string): string | null => attributeValue(name, read(name));
  switch (tag) {
    case "title":
      return "title";
    case "meta": {
      if (text("charset") !== null) return "charset";
      for (const name of metaKeyNames) {
        const value = text(name);
        if (value !== null) return `${name}=${value}`;
      }
      return undefined;
    }
    case "link":
      return text("rel") === "canonical" ? "canonical" : undefined;
  }
  return undefined;
}
