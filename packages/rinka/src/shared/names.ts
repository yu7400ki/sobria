/** camelCase、PascalCase、snake_case の名前を kebab-case にする。大文字の連続は 1 語として扱う。 */
export function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase();
}

/** props の名前を属性名にする。`userId` は `user-id`、`imageURL` は `image-url` になる。 */
export const propToAttribute = toKebabCase;

/**
 * `src/elements/` からの相対パスで表現した要素のファイルのタグ名を返す。
 * `index` のファイルはディレクトリの名前になる。Custom Element の名前にならないときは例外を投げる。
 */
export function tagFromPath(prefix: string, path: string): string {
  const segments = path.replace(/\.[jt]sx?$/, "").split("/");
  if (segments.length > 1 && segments.at(-1) === "index") segments.pop();
  const tag = [prefix, ...segments.map(toKebabCase)].join("-");
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(tag)) {
    throw new Error(
      `src/elements/${path} のタグ名 ${tag} は、Custom Element の名前にできません。ファイル名とディレクトリ名には、英数字、-、_ だけを使用してください。`,
    );
  }
  return tag;
}
