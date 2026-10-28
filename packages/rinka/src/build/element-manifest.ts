import { extname } from "node:path";

import type { ESTree } from "vite";

import { formAttributeTypes, propKinds } from "../shared/element.ts";
import { customEventName } from "../shared/names.ts";
import { langs, parseModule, walk } from "./ast.ts";
import { elementFunction } from "./element-transform.ts";
import { usesForm } from "./form-usage.ts";
import { optionsOf, propsParamStart, unresolvedProps } from "./props.ts";
import type {
  DocComment,
  ElementDescription,
  ExposedDescription,
  TypeChecker,
} from "./type-checker.ts";

/** Custom Elements Manifest の型の記述を表す。 */
export interface ManifestType {
  readonly text: string;
}

/** 説明を持つ項目に共通する欄を表す。 */
export interface Documented {
  readonly summary?: string;
  readonly description?: string;
  readonly deprecated?: string | true;
}

/** Custom Elements Manifest の属性を表す。 */
export interface ManifestAttribute extends Documented {
  readonly name: string;
  /** 属性に対応するホストのプロパティの名前である。 */
  readonly fieldName?: string;
  readonly type?: ManifestType;
}

/** Custom Elements Manifest のイベントを表す。 */
export interface ManifestEvent extends Documented {
  readonly name: string;
  readonly type: ManifestType;
}

/** Custom Elements Manifest のスロットを表す。デフォルトのスロットの名前は空文字列である。 */
export interface ManifestSlot extends Documented {
  readonly name: string;
}

/** Custom Elements Manifest のメソッドの引数を表す。 */
export interface ManifestParameter {
  readonly name: string;
  readonly type?: ManifestType;
  readonly optional?: true;
  readonly rest?: true;
}

/** Custom Elements Manifest のクラスのメンバーを表す。 */
export type ManifestMember =
  | (Documented & {
      readonly kind: "field";
      readonly name: string;
      readonly type?: ManifestType;
      readonly readonly?: true;
    })
  | (Documented & {
      readonly kind: "method";
      readonly name: string;
      readonly parameters: readonly ManifestParameter[];
      readonly return: { readonly type: ManifestType };
    });

/** Custom Elements Manifest の CSS のカスタムプロパティを表す。名前は `--` で始まる。 */
export interface ManifestCssProperty extends Documented {
  readonly name: string;
  readonly syntax?: string;
  readonly default?: string;
}

/** Custom Elements Manifest の、Custom Element の宣言を表す。 */
export interface CustomElementDeclaration extends Documented {
  readonly kind: "class";
  readonly customElement: true;
  readonly tagName: string;
  readonly name: string;
  readonly attributes?: readonly ManifestAttribute[];
  readonly events?: readonly ManifestEvent[];
  readonly slots?: readonly ManifestSlot[];
  readonly members?: readonly ManifestMember[];
  readonly cssParts?: readonly { readonly name: string }[];
  readonly cssProperties?: readonly ManifestCssProperty[];
}

/** Custom Elements Manifest の、1 つの JS のモジュールを表す。 */
export interface ManifestModule {
  readonly kind: "javascript-module";
  readonly path: string;
  readonly declarations: readonly CustomElementDeclaration[];
  readonly exports: readonly {
    readonly kind: "custom-element-definition";
    readonly name: string;
    readonly declaration: { readonly name: string; readonly module: string };
  }[];
}

/** Custom Elements Manifest の全体を表す。 */
export interface ManifestPackage {
  readonly schemaVersion: "2.1.0";
  readonly modules: readonly ManifestModule[];
}

/** マニフェストに記述する要素の、タグ名、ソースのパスとコード、ビルドしたモジュールのパスを表す。 */
export interface ManifestElement {
  readonly tag: string;
  /** プロジェクトのルートからの、`/` で区切ったソースのパスである。 */
  readonly file: string;
  readonly code: string;
  /** パッケージのルートからの、`/` で区切ったビルドしたモジュールのパスである。 */
  readonly path: string;
  /** ソースの絶対パスである。 */
  readonly source: string;
}

/** 要素ごとに、自分自身を登録するモジュールを記述したマニフェストを返す。型は `checker` で解析する。 */
export function manifestOf(
  elements: readonly ManifestElement[],
  checker: TypeChecker,
): ManifestPackage {
  return {
    schemaVersion: "2.1.0",
    modules: elements.map(({ tag, file, code, path, source }) => {
      const declaration = describeElement(code, { tag, file }, (text, position) =>
        checker.describe(source, text, position),
      );
      return {
        kind: "javascript-module",
        path,
        declarations: [declaration],
        exports: [
          {
            kind: "custom-element-definition",
            name: tag,
            declaration: { name: declaration.name, module: path },
          },
        ],
      };
    }),
  };
}

/** 要素のファイルのコード `code` の、位置 `position` にある要素の関数の型を、マニフェストのために解析する関数を表す。 */
export type DescribeTypes = (code: string, position: number) => ElementDescription | undefined;

/**
 * タグ名 `tag` の要素のファイル `file` のコード `code` から、要素の宣言を返す。
 * 属性、イベント、スロットは、要素を登録するときと同じ props の分類から算出する。
 * 要素の関数の説明と、props と `Ctx<M>` の `M` のメンバーの型、説明、イベントの `detail` の型は、型チェッカーから取得する。
 */
export function describeElement(
  code: string,
  { tag, file }: { readonly tag: string; readonly file: string },
  describeTypes: DescribeTypes,
): CustomElementDeclaration {
  const program = parseModule(code, { id: file, file, lang: langs.get(extname(file)) ?? "tsx" });
  const { fn, id, ctx } = elementFunction(program, file);
  propsParamStart(fn, file);
  const described = describeTypes(code, id.start);
  if (described === undefined) throw unresolvedProps(file);
  const kinds = propKinds(
    optionsOf(
      new Map(described.props.map(({ name: prop, kind }) => [prop, kind])),
      usesForm(fn, ctx, file),
    ),
  );
  const attributeOf = new Map(
    [...kinds.attributes].map(([attribute, { name: prop }]) => [prop, attribute]),
  );
  const attributes: ManifestAttribute[] = [];
  const events: ManifestEvent[] = [];
  const slots: ManifestSlot[] = [];
  const members: ManifestMember[] = [];
  for (const { name: prop, type, docs: comment, detail } of described.props) {
    const doc = documented(comment);
    if (kinds.slots.has(prop)) {
      slots.push({ name: prop === "children" ? "" : prop, ...doc });
      continue;
    }
    const typed = { type: { text: type } };
    members.push({ kind: "field", name: prop, ...typed, ...doc });
    const attribute = attributeOf.get(prop);
    if (attribute !== undefined) {
      attributes.push({ name: attribute, fieldName: prop, ...typed, ...doc });
    }
    if (kinds.events.has(prop)) {
      events.push({
        name: customEventName(prop),
        type: { text: `CustomEvent<${detail ?? "unknown"}>` },
        ...doc,
      });
    }
  }
  for (const [attribute, type] of Object.entries(formAttributeTypes)) {
    if (kinds.reflects.has(attribute) && !kinds.names.includes(attribute)) {
      attributes.push({ name: attribute, type: { text: type } });
    }
  }
  members.push(...described.exposed.map(exposedMember));
  const cssProperties = described.docs.tags.flatMap((entry) =>
    entry.name === "cssprop" ? cssPropertyOf(entry.text) : [],
  );
  return {
    kind: "class",
    customElement: true,
    tagName: tag,
    name: id.name,
    ...documented(described.docs),
    attributes: nonEmpty(attributes),
    events: nonEmpty(events),
    slots: nonEmpty(slots),
    members: nonEmpty(members),
    cssParts: nonEmpty(partsOf(fn).map((part) => ({ name: part }))),
    cssProperties: nonEmpty(cssProperties),
  };
}

/** `Ctx<M>` の `M` のメンバーを、マニフェストのメソッドかフィールドにする。 */
function exposedMember(member: ExposedDescription): ManifestMember {
  const doc = documented(member.docs);
  if (member.kind === "method") {
    return {
      kind: "method",
      name: member.name,
      parameters: member.parameters.map(({ name, type, optional, rest }) => ({
        name,
        type: { text: type },
        ...(optional && { optional: true }),
        ...(rest && { rest: true }),
      })),
      return: { type: { text: member.returnType } },
      ...doc,
    };
  }
  return {
    kind: "field",
    name: member.name,
    type: { text: member.type },
    ...(member.readonly && { readonly: true }),
    ...doc,
  };
}

/** 型チェッカーが返した JSDoc から、説明と、`@summary` と `@deprecated` のタグを返す。 */
function documented({ description, tags }: DocComment): Documented {
  const text = description.trim();
  const summary = tags.find(({ name }) => name === "summary")?.text.trim();
  const deprecated = tags.find(({ name }) => name === "deprecated")?.text.trim();
  return {
    ...(text === "" ? {} : { description: text }),
    ...(summary ? { summary } : {}),
    ...(deprecated === undefined ? {} : { deprecated: deprecated === "" ? true : deprecated }),
  };
}

/** `items` が空なら `undefined` を返す。 */
const nonEmpty = <T>(items: readonly T[]): readonly T[] | undefined =>
  items.length > 0 ? items : undefined;

/**
 * `@cssprop` のタグの本文から、CSS のカスタムプロパティを返す。
 * 本文には、省略できる `{構文}`、`--名前` か `[--名前=デフォルト値]`、省略できる説明を、この順に記述する。説明の前の `-` は省略できる。
 * 本文がこの形でなければ、空の配列を返す。
 */
function cssPropertyOf(text: string): ManifestCssProperty[] {
  const match =
    /^(?:\{([^}]*)\}\s*)?(?:\[(--[\w-]+)(?:=([^\]]*))?\]|(--[\w-]+))(?:\s+(?:-\s+)?([\s\S]*))?$/.exec(
      text.trim(),
    );
  if (!match) return [];
  const [, syntax, bracketed, value, bare, description] = match;
  return [
    {
      name: (bracketed ?? bare)!,
      ...(syntax === undefined ? {} : { syntax: syntax.trim() }),
      ...(value === undefined ? {} : { default: value }),
      ...(description?.trim() ? { description: description.trim() } : {}),
    },
  ];
}

/** 要素の関数 `fn` の JSX で、小文字で始まるタグに文字列のリテラルで記述した `part` の名前を、現れた順に重複を除いて返す。 */
function partsOf(fn: ESTree.Function): string[] {
  const parts = new Set<string>();
  if (!fn.body) return [];
  walk(fn.body, (node) => {
    if (
      node.type !== "JSXOpeningElement" ||
      node.name.type !== "JSXIdentifier" ||
      !/^[a-z]/.test(node.name.name)
    ) {
      return;
    }
    for (const attribute of node.attributes) {
      if (
        attribute.type === "JSXAttribute" &&
        attribute.name.type === "JSXIdentifier" &&
        attribute.name.name === "part" &&
        attribute.value?.type === "Literal" &&
        typeof attribute.value.value === "string"
      ) {
        for (const part of attribute.value.value.split(/\s+/)) if (part !== "") parts.add(part);
      }
    }
  });
  return [...parts];
}
