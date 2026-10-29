import { withBase } from "../shared/base.ts";
import type { NavigationProps } from "../shared/navigation.ts";
import { internalUrlPrefix } from "../shared/wire.ts";
import { escapeAttribute } from "./html.ts";

/**
 * 文書を出力する描画で、特別に扱うタグの扱いを表す。
 * `head` は `<head>` に移動するタグ、`html` と `body` は属性を文書の同じタグの開始タグに移動して子だけを描画するタグ、`transparent` は子だけを描画するタグである。
 */
type DocumentTag = "head" | "html" | "body" | "transparent";

/** 文書を出力する描画で、特別に扱うタグと、その扱いである。 */
export const documentTags: ReadonlyMap<string, DocumentTag> = new Map([
  ["title", "head"],
  ["meta", "head"],
  ["link", "head"],
  ["html", "html"],
  ["body", "body"],
  ["head", "transparent"],
]);

/** 配下のタグを `<head>` に移動しないタグである。 */
export const headlessParents: ReadonlySet<string> = new Set(["svg", "noscript"]);

/** `<body>` に置いても効果のある `<link>` の `rel` の値である。 */
const bodyOkRels: ReadonlySet<string> = new Set([
  "stylesheet",
  "preload",
  "modulepreload",
  "prefetch",
  "preconnect",
  "dns-prefetch",
  "pingback",
]);

/** `<head>` に移動できない位置にある `tag` を、開発時に警告するかどうかを返す。`<link>` は、`rel` の値がすべて `<body>` でも効果のある値なら警告しない。 */
export function warnsOutOfHead(tag: string, props: Record<string, unknown>): boolean {
  if (tag !== "link") return true;
  const rel = props.rel;
  return (
    typeof rel !== "string" ||
    !rel
      .toLowerCase()
      .split(/\s+/)
      .filter((value) => value !== "")
      .every((value) => bodyOkRels.has(value))
  );
}

/**
 * 文書の骨組みに移動するものを、目印の番号ごとに表す。`depth` は、記述したルートのファイルの深さである。
 * `head` は `<head>` に移動するタグで、`html` と `body` は、そのタグの属性で、`navigation` は `<Navigation>` の props である。
 */
export type Hoisted =
  | {
      readonly kind: "head";
      readonly key: string | undefined | Promise<string | undefined>;
      readonly depth: number;
    }
  | {
      readonly kind: "html" | "body";
      readonly values: Attributes;
      readonly depth: number;
    }
  | {
      readonly kind: "navigation";
      readonly values: NavigationValues;
      readonly depth: number;
    };

/** `<Navigation>` に指定した props を、名前ごとに表す。 */
type NavigationValues = ReadonlyMap<keyof NavigationProps, NavigationProps[keyof NavigationProps]>;

/** 属性の名前ごとの値を表す。`null` は、属性を出力しないことを表す。 */
export type Attributes = ReadonlyMap<string, string | null>;

/** `<head>` に出力する候補のタグを表す。 */
export interface HeadOutput {
  readonly html: string;
  readonly key: string | undefined;
  readonly depth: number;
}

/**
 * 文書の順序で並んだ `<head>` のタグから、キーごとに、深さが最も大きく、同じ深さなら後のタグだけを選択して、文書の順序で返す。
 * 選択したタグは、そのキーのタグが最初に現れた位置に置く。`<meta charset>` は、rinka が出力するので選択しない。
 */
function selectHead(tags: readonly HeadOutput[]): HeadOutput[] {
  const chosen = new Map<string | number, HeadOutput>();
  for (const [index, tag] of tags.entries()) {
    if (tag.key === "charset") continue;
    const key = tag.key ?? index;
    const current = chosen.get(key);
    if (!current || tag.depth >= current.depth) chosen.set(key, tag);
  }
  return [...chosen.values()];
}

/**
 * 文書の順序で並んだ記録の値を、名前ごとに、深さが最も大きく、同じ深さなら後の値にする。
 * 値は、その名前が最初に現れた順に並べる。
 */
export function mergeByName<K, V>(
  records: readonly { readonly values: ReadonlyMap<K, V>; readonly depth: number }[],
): Map<K, V> {
  const chosen = new Map<K, { readonly value: V; readonly depth: number }>();
  for (const { values, depth } of records) {
    for (const [name, value] of values) {
      const current = chosen.get(name);
      if (!current || depth >= current.depth) chosen.set(name, { value, depth });
    }
  }
  return new Map([...chosen].map(([name, { value }]) => [name, value]));
}

/** `parts` の `<head>` のタグのうち、キーごとに選択したタグと、`<Navigation>` の出力を連結する。 */
export const headTags = (parts: DocumentParts): string =>
  selectHead(parts.heads)
    .map(({ html }) => html)
    .join("") + navigationHead(parts.navigation);

/** `<Navigation>` の props を、`<head>` に出力する View Transitions の `<style>` と Speculation Rules の `<script>` にする。 */
function navigationHead(values: NavigationValues): string {
  const prefetch = values.get("prefetch");
  const rules = {
    prefetch: [
      {
        where: {
          and: [
            { href_matches: `${withBase("/")}*` },
            { not: { href_matches: `${internalUrlPrefix()}*` } },
          ],
        },
        eagerness: prefetch,
      },
    ],
  };
  return (
    (values.get("transitions") === true ? "<style>@view-transition{navigation:auto}</style>" : "") +
    (typeof prefetch === "string"
      ? `<script type="speculationrules">${JSON.stringify(rules)}</script>`
      : "")
  );
}

/** `attributes` を、開始タグに出力する属性の文字列にする。 */
export const attributesText = (attributes: ReadonlyMap<string, string>): string =>
  [...attributes]
    .map(([name, value]) => (value === "" ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`))
    .join("");

/** 文書の順序で並んだ `<html>` か `<body>` の記録の属性を、`mergeByName` の規則で名前ごとに 1 つの値にし、値が `null` の属性を除く。 */
export const rootAttributesOf = (
  records: readonly { readonly values: Attributes; readonly depth: number }[],
): Map<string, string> =>
  new Map(
    [...mergeByName(records)].filter((entry): entry is [string, string] => entry[1] !== null),
  );

/**
 * シェルから取り出した、文書の骨組みに並べる値を表す。
 * `heads` は、文書の順序で並んだ `<head>` のタグで、キーが同じタグを 1 つにする前のものである。`html` と `body` は、開始タグに出力する属性である。
 */
export interface DocumentParts {
  readonly heads: readonly HeadOutput[];
  readonly html: ReadonlyMap<string, string>;
  readonly body: ReadonlyMap<string, string>;
  readonly navigation: NavigationValues;
  /** シェルから、移動したタグと目印を取り除いた残りである。 */
  readonly rest: string;
}
