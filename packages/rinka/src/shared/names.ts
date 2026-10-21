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
  if (segments.at(-1) === "index") {
    if (segments.length === 1) {
      throw new Error(
        `src/elements/${path} は、ディレクトリの名前が無いので、タグ名を決定できません。ファイル名を変更してください。`,
      );
    }
    segments.pop();
  }
  const tag = [prefix, ...segments.map(toKebabCase)].join("-");
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(tag)) {
    throw new Error(
      `src/elements/${path} のタグ名 ${tag} は、Custom Element の名前にできません。ファイル名とディレクトリ名には、英数字、-、_ だけを使用してください。`,
    );
  }
  return tag;
}

/** rinka が予約している props の名前の種類を表す。`load:` は `load:` で始まるすべての名前を表す。 */
export type ReservedProp = "ref" | "key" | "load:";

/** 予約された props の名前なら、その種類を返す。 */
export function reservedProp(name: string): ReservedProp | undefined {
  if (name === "ref" || name === "key") return name;
  return name.startsWith("load:") ? "load:" : undefined;
}

/** `on` の直後に大文字が続く、イベントの props の名前かどうかを返す。 */
export const isEventProp = (name: string): boolean => /^on[A-Z]/.test(name);

/** イベントの props の名前から、イベント名を返す。`onSelect` は `select`、`onLikeClick` は `like-click` になる。 */
export const eventName = (prop: string): string => toKebabCase(prop.slice(2));
