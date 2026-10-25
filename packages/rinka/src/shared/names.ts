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
 * 要素のディレクトリからの相対パスで表現した要素のファイルのタグ名を返す。
 * `index` のファイルはディレクトリの名前になる。Custom Element の名前にならないときは例外を投げる。
 */
export function tagFromPath(prefix: string, path: string): string {
  const segments = path.replace(/\.[jt]sx?$/, "").split("/");
  if (segments.at(-1) === "index") {
    if (segments.length === 1) {
      throw new Error(
        `要素のファイル ${path} は、ディレクトリの名前が無いので、タグ名を決定できません。ファイル名を変更してください。`,
      );
    }
    segments.pop();
  }
  const tag = [prefix, ...segments.map(toKebabCase)].join("-");
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(tag)) {
    throw new Error(
      `タグ名 ${tag}（要素のファイル ${path}）は、Custom Element の名前にできません。ファイル名とディレクトリ名には、英数字、-、_ だけを使用してください。`,
    );
  }
  return tag;
}

/** 英字の大文字を表す。 */
type UpperLetter =
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L"
  | "M"
  | "N"
  | "O"
  | "P"
  | "Q"
  | "R"
  | "S"
  | "T"
  | "U"
  | "V"
  | "W"
  | "X"
  | "Y"
  | "Z";

/** rinka が予約している props の名前の種類を表す。`load:` は `load:` で始まるすべての名前を表す。 */
export type ReservedProp = "ref" | "key" | "load:";

/** 予約された props の名前なら、その種類を返す。 */
export function reservedProp(name: string): ReservedProp | undefined {
  if (name === "ref" || name === "key") return name;
  return name.startsWith("load:") ? "load:" : undefined;
}

/** `load:` で始まる props の名前を表す。 */
export type LoadPropName = `load:${string}`;

/** 名前 `K` の予約された props の種類を表す。予約されていなければ `never` を表す。 */
export type ReservedPropOf<K extends string> = K extends LoadPropName
  ? "load:"
  : Extract<K, ReservedProp>;

/** 要素のファイルの `export const load` に記述できる、デフォルトの起動タイミングの名前を列挙する。 */
export const defaultLoads = ["load", "idle", "visible"] as const;

/** 要素の起動のタイミングの名前を列挙する。 */
export const loadTimings = [...defaultLoads, "media"] as const;

/** 要素の起動のタイミングの名前を表す。 */
export type LoadTiming = (typeof loadTimings)[number];

/** `on` と英字の大文字で始まる、イベントの props の名前を表す。 */
export type EventPropName = `on${UpperLetter}${string}`;

/** `on` と英字の大文字で始まる、イベントの props の名前かどうかを返す。 */
export const isEventProp = (name: string): name is EventPropName => /^on[A-Z]/.test(name);

/** `aria` か `data` と英字の大文字で始まる名前を表す。 */
export type AriaOrDataPropName = `${"aria" | "data"}${UpperLetter}${string}`;

/** `aria` か `data` と英字の大文字で始まる名前かどうかを返す。 */
export const isAriaOrDataProp = (name: string): name is AriaOrDataPropName =>
  /^(aria|data)[A-Z]/.test(name);

/** 英字の小文字と数字を表す。 */
type LowerOrDigit =
  | Lowercase<UpperLetter>
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9";

/**
 * `toKebabCase` が名前 `S` から返す文字列を表す。`Prev` は直前の文字で、`Acc` は変換を終えた部分である。
 * 大文字の前には、直前が小文字か数字のときと、直前が大文字で直後が小文字のときに `-` を挿入する。
 */
type KebabCase<
  S extends string,
  Prev extends string = "",
  Acc extends string = "",
> = S extends `${infer C}${infer Rest}`
  ? KebabCase<
      Rest,
      C,
      `${Acc}${C extends "_"
        ? "-"
        : C extends UpperLetter
          ? Prev extends LowerOrDigit
            ? `-${Lowercase<C>}`
            : Prev extends UpperLetter
              ? Rest extends `${Lowercase<UpperLetter>}${string}`
                ? `-${Lowercase<C>}`
                : Lowercase<C>
              : Lowercase<C>
          : C}`
    >
  : Acc;

/** イベントの props の名前 `K` から、要素が発行する `CustomEvent` の名前を表す。 */
export type CustomEventName<K extends EventPropName> = K extends `on${infer Name}`
  ? KebabCase<Name>
  : never;

/** 要素が発行する `CustomEvent` の名前を、イベントの props の名前から返す。`onSelect` は `select`、`onLikeClick` は `like-click` になる。 */
export const customEventName = (prop: string): string => toKebabCase(prop.slice(2));

/** ネイティブのタグと、要素のホストに登録するリスナーのイベント名を、イベントの props の名前から返す。`onClick` は `click`、`onDblClick` は `dblclick` になる。 */
export const listenerEventName = (prop: string): string => prop.slice(2).toLowerCase();
