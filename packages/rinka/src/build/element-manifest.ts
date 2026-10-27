import { extname } from "node:path";

import type { ESTree, ParseResult } from "vite";

import { formAttributeTypes, propKinds } from "../shared/element.ts";
import { customEventName } from "../shared/names.ts";
import { importedNames, langs, parseWithComments, walk } from "./ast.ts";
import { elementFunction } from "./element-transform.ts";
import { entries } from "./entries.ts";
import { CompileError } from "./errors.ts";
import { usesForm } from "./form-usage.ts";
import { fileTypes, memberName, optionsOf, propMembers, type FileTypes } from "./props.ts";

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
  readonly fieldName: string;
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
}

/** 要素ごとに、自分自身を登録するモジュールを記述したマニフェストを返す。 */
export function manifestOf(elements: readonly ManifestElement[]): ManifestPackage {
  return {
    schemaVersion: "2.1.0",
    modules: elements.map(({ tag, file, code, path }) => {
      const declaration = describeElement(code, { tag, file });
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

/**
 * タグ名 `tag` の要素のファイル `file` のコード `code` から、要素の宣言を返す。
 * 属性、イベント、スロットは、要素を登録するときと同じ props の分類から算出する。
 * 型は型注釈のソースの文字列で記述し、説明は JSDoc から取得する。
 */
export function describeElement(
  code: string,
  { tag, file }: { readonly tag: string; readonly file: string },
): CustomElementDeclaration {
  const { program, comments } = parseWithComments(code, {
    id: file,
    file,
    lang: langs.get(extname(file)) ?? "tsx",
  });
  const source = new Source(code, comments, fileTypes(program));
  const { exported, fn, name } = elementFunction(program, file);
  const { tags, ...docs } = source.docsOf(exported);
  const props = propMembers(program, fn, file);
  const kinds = propKinds(optionsOf(props, usesForm(fn, file)));
  const attributeOf = new Map(
    [...kinds.attributes].map(([attribute, { name: prop }]) => [prop, attribute]),
  );
  const attributes: ManifestAttribute[] = [];
  const events: ManifestEvent[] = [];
  const slots: ManifestSlot[] = [];
  const members: ManifestMember[] = [];
  for (const [prop, { signature }] of props) {
    const { tags: _, ...doc } = source.docsOf(signature);
    if (kinds.slots.has(prop)) {
      slots.push({ name: prop === "children" ? "" : prop, ...doc });
      continue;
    }
    const type = source.signatureType(signature);
    const typed = type === undefined ? {} : { type: { text: type } };
    members.push({ kind: "field", name: prop, ...typed, ...doc });
    const attribute = attributeOf.get(prop);
    if (attribute !== undefined) {
      attributes.push({ name: attribute, fieldName: prop, ...typed, ...doc });
    }
    if (kinds.events.has(prop)) {
      const detail = source.detailType(signature);
      events.push({
        name: customEventName(prop),
        type: { text: `CustomEvent<${detail}>` },
        ...doc,
      });
    }
  }
  for (const [attribute, type] of Object.entries(formAttributeTypes)) {
    if (kinds.reflects.has(attribute) && !props.has(attribute)) {
      attributes.push({ name: attribute, fieldName: attribute, type: { text: type } });
    }
  }
  members.push(...source.exposed(program, fn, file));
  const cssProperties = tags.flatMap((entry) =>
    entry.tag === "cssprop" ? cssPropertyOf(entry.text) : [],
  );
  return {
    kind: "class",
    customElement: true,
    tagName: tag,
    name,
    ...docs,
    attributes: nonEmpty(attributes),
    events: nonEmpty(events),
    slots: nonEmpty(slots),
    members: nonEmpty(members),
    cssParts: nonEmpty(partsOf(fn).map((part) => ({ name: part }))),
    cssProperties: nonEmpty(cssProperties),
  };
}

/** `items` が空なら `undefined` を返す。 */
const nonEmpty = <T>(items: readonly T[]): readonly T[] | undefined =>
  items.length > 0 ? items : undefined;

/** JSDoc の説明と、説明より後に記述したタグを表す。 */
interface Docs extends Documented {
  readonly tags: readonly { readonly tag: string; readonly text: string }[];
}

/** 関数の引数のノードを表す。 */
type Param = ESTree.ParamPattern;

/** 関数の型の、引数と戻り値の型注釈を表す。 */
interface Callable {
  readonly params: readonly Param[];
  readonly returnType?: ESTree.TSTypeAnnotation | null;
}

/** Props の型のメンバーの宣言を表す。 */
type PropSignature = ESTree.TSPropertySignature | ESTree.TSMethodSignature;

/** 要素のファイルのコードとコメントから、型の文字列と説明を取得する。 */
class Source {
  constructor(
    private readonly code: string,
    private readonly comments: ParseResult["comments"],
    private readonly types: FileTypes,
  ) {}

  /** ノードのソースの文字列を返す。 */
  text(node: { readonly start: number; readonly end: number }): string {
    return this.code.slice(node.start, node.end);
  }

  /** ノードの直前に、空白だけを挟んで記述した JSDoc の説明とタグを返す。 */
  docsOf(node: { readonly start: number }): Docs {
    const comment = this.comments.findLast((candidate) => candidate.end <= node.start);
    if (
      comment?.type !== "Block" ||
      !comment.value.startsWith("*") ||
      this.code.slice(comment.end, node.start).trim() !== ""
    ) {
      return { tags: [] };
    }
    return parseJsDoc(comment.value.slice(1));
  }

  /** Props の型のメンバーの型を返す。メソッドは関数型の文字列にし、getter は戻り値の型を、setter は引数の型を返す。 */
  signatureType(signature: PropSignature): string | undefined {
    if (signature.type === "TSPropertySignature") {
      return this.annotationText(signature.typeAnnotation);
    }
    if (signature.kind === "get") return this.annotationText(signature.returnType);
    if (signature.kind === "set") return this.paramType(signature.params[0]);
    return `(${this.paramsText(signature.params)}) => ${this.returnText(signature.returnType)}`;
  }

  /**
   * イベントの props の宣言から、`CustomEvent` の `detail` の型を返す。
   * 引数が無ければ `null` にし、第 1 引数の型から `undefined` を除き、第 1 引数を省略できれば `null` を加える。
   */
  detailType(signature: PropSignature): string {
    const params = this.signatureParams(signature);
    if (params === undefined) return "unknown";
    const [first] = params;
    if (first === undefined) return "null";
    if (first.type === "RestElement") {
      const rest = first.typeAnnotation && this.types.resolve(first.typeAnnotation.typeAnnotation);
      return rest?.type === "TSArrayType" ? this.text(rest.elementType) : "unknown";
    }
    const annotation = first.type === "Identifier" ? first.typeAnnotation : undefined;
    if (!annotation) return "unknown";
    const type = this.types.resolve(annotation.typeAnnotation);
    const members = type.type === "TSUnionType" ? type.types : [type];
    const defined = members.filter((member) => member.type !== "TSUndefinedKeyword");
    const optional =
      (first.type === "Identifier" && first.optional) || defined.length < members.length;
    if (!optional) return this.text(withoutParens(annotation.typeAnnotation));
    if (defined.length === 0) return "null";
    const text =
      defined.length === members.length
        ? this.text(type)
        : defined.map((member) => this.text(member)).join(" | ");
    return defined.some((member) => member.type === "TSNullKeyword") ? text : `${text} | null`;
  }

  /**
   * 要素の関数 `fn` の第 2 引数の型注釈 `Ctx<M>` の、`M` のメンバーを返す。
   * `M` を、型リテラルか、同じファイルで宣言した type か interface の名前で記述していなければ、ビルドのエラーにする。
   */
  exposed(program: ESTree.Program, fn: ESTree.Function, file: string): ManifestMember[] {
    const declared = fn.params[1];
    const param = declared?.type === "AssignmentPattern" ? declared.left : declared;
    const annotation =
      param?.type === "Identifier" || param?.type === "ObjectPattern"
        ? param.typeAnnotation?.typeAnnotation
        : undefined;
    const ctx = importedNames(program, entries.main).get("Ctx");
    if (
      annotation?.type !== "TSTypeReference" ||
      annotation.typeName.type !== "Identifier" ||
      !ctx?.has(annotation.typeName.name)
    ) {
      return [];
    }
    const methods = annotation.typeArguments?.params[0];
    if (methods === undefined || methods.type === "TSObjectKeyword") return [];
    const signatures = this.types.members(methods);
    if (signatures === undefined) {
      throw new CompileError(
        `${file}: Ctx<M> の M には、型リテラルか、同じファイルで宣言した type か interface の名前を記述してください。`,
      );
    }
    const setters = new Set(
      signatures.flatMap((signature) =>
        signature.type === "TSMethodSignature" && signature.kind === "set"
          ? [memberName(signature)]
          : [],
      ),
    );
    const accessors = new Set<string>();
    return signatures.flatMap((signature): ManifestMember[] => {
      const name = memberName(signature);
      if (name === undefined) return [];
      const { tags: _, ...doc } = this.docsOf(signature);
      if (signature.type === "TSMethodSignature") {
        if (signature.kind === "method") {
          return [this.method(name, signature.params, signature.returnType, doc)];
        }
        if (accessors.has(name)) return [];
        accessors.add(name);
        const type = this.signatureType(signature);
        return [
          {
            kind: "field",
            name,
            ...(type === undefined ? {} : { type: { text: type } }),
            ...(signature.kind === "get" && !setters.has(name) ? { readonly: true } : {}),
            ...doc,
          },
        ];
      }
      if (signature.type !== "TSPropertySignature") return [];
      const fnType = this.functionType(signature.typeAnnotation?.typeAnnotation);
      if (fnType) return [this.method(name, fnType.params, fnType.returnType, doc)];
      const type = this.annotationText(signature.typeAnnotation);
      return [
        {
          kind: "field",
          name,
          ...(type === undefined ? {} : { type: { text: type } }),
          ...(signature.readonly ? { readonly: true } : {}),
          ...doc,
        },
      ];
    });
  }

  /** Props の型のメンバーが関数なら、その引数を返す。getter は戻り値の型を、setter は引数の型を、関数型として扱う。 */
  private signatureParams(signature: PropSignature): readonly Param[] | undefined {
    if (signature.type === "TSPropertySignature") {
      return this.functionType(signature.typeAnnotation?.typeAnnotation)?.params;
    }
    if (signature.kind === "get") {
      return this.functionType(signature.returnType?.typeAnnotation)?.params;
    }
    if (signature.kind === "set") {
      const [param] = signature.params;
      const annotation =
        param && param.type !== "TSParameterProperty" ? param.typeAnnotation : undefined;
      return this.functionType(annotation?.typeAnnotation)?.params;
    }
    return signature.params;
  }

  /**
   * 型の記述から、括弧と、`undefined` と `null` との合併と、同じファイルで宣言した type の名前を外した関数の型の、引数と戻り値の型を返す。
   * 呼び出しのシグネチャだけを持つ interface と型リテラルは、最初のシグネチャを返す。関数の型でなければ `undefined` を返す。
   */
  private functionType(type: ESTree.TSType | null | undefined): Callable | undefined {
    if (!type) return undefined;
    const resolved = this.types.resolve(type);
    if (resolved.type === "TSUnionType") {
      const [only, ...rest] = resolved.types.filter(
        (member) => member.type !== "TSUndefinedKeyword" && member.type !== "TSNullKeyword",
      );
      return rest.length === 0 ? this.functionType(only) : undefined;
    }
    if (resolved.type === "TSFunctionType") return resolved;
    const signatures = this.types.members(resolved);
    const [signature] = signatures ?? [];
    return signature?.type === "TSCallSignatureDeclaration" &&
      signatures?.every((member) => member.type === "TSCallSignatureDeclaration")
      ? signature
      : undefined;
  }

  /** メソッドのメンバーを返す。 */
  private method(
    name: string,
    params: readonly Param[],
    returnType: ESTree.TSTypeAnnotation | null | undefined,
    doc: Documented,
  ): ManifestMember {
    return {
      kind: "method",
      name,
      parameters: params.map((param) => this.parameter(param)),
      return: { type: { text: this.returnText(returnType) } },
      ...doc,
    };
  }

  /** 引数のノードから、メソッドの引数を返す。 */
  private parameter(param: Param): ManifestParameter {
    const binding = param.type === "RestElement" ? param.argument : param;
    const name = binding.type === "Identifier" ? binding.name : this.text(binding);
    const type = this.paramType(param);
    return {
      name,
      ...(type === undefined ? {} : { type: { text: type } }),
      ...(param.type === "Identifier" && param.optional ? { optional: true } : {}),
      ...(param.type === "RestElement" ? { rest: true } : {}),
    };
  }

  /** 引数の型注釈の文字列を返す。 */
  private paramType(param: Param | undefined): string | undefined {
    if (param === undefined || param.type === "TSParameterProperty") return undefined;
    return this.annotationText(param.typeAnnotation);
  }

  /** 型注釈の型の文字列を返す。 */
  private annotationText(
    annotation: ESTree.TSTypeAnnotation | null | undefined,
  ): string | undefined {
    return annotation ? this.text(annotation.typeAnnotation) : undefined;
  }

  /** 引数の並びのソースの文字列を返す。 */
  private paramsText(params: readonly Param[]): string {
    const first = params[0];
    const last = params.at(-1);
    return first && last ? this.code.slice(first.start, last.end) : "";
  }

  /** 戻り値の型注釈の文字列を返す。型注釈が無ければ `unknown` を返す。 */
  private returnText(returnType: ESTree.TSTypeAnnotation | null | undefined): string {
    return this.annotationText(returnType) ?? "unknown";
  }
}

/** 型を囲む括弧を外した型を返す。 */
function withoutParens(type: ESTree.TSType): ESTree.TSType {
  return type.type === "TSParenthesizedType" ? withoutParens(type.typeAnnotation) : type;
}

/** JSDoc の本文（先頭の `/**` の 2 つ目の `*` から後）から、説明とタグを返す。 */
function parseJsDoc(value: string): Docs {
  const lines = value.split("\n").map((line) => line.replace(/^\s*\*? ?/, "").trimEnd());
  const description: string[] = [];
  const tags: { tag: string; text: string }[] = [];
  for (const line of lines) {
    const tag = /^@(\w+)\s*(.*)$/.exec(line);
    if (tag) tags.push({ tag: tag[1]!, text: tag[2]! });
    else if (tags.length > 0) tags.at(-1)!.text += `\n${line}`;
    else description.push(line);
  }
  const text = description.join("\n").trim();
  const summary = tags.find(({ tag }) => tag === "summary")?.text.trim();
  const deprecated = tags.find(({ tag }) => tag === "deprecated")?.text.trim();
  return {
    ...(text === "" ? {} : { description: text }),
    ...(summary ? { summary } : {}),
    ...(deprecated === undefined ? {} : { deprecated: deprecated === "" ? true : deprecated }),
    tags,
  };
}

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
