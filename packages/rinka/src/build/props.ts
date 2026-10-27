import type { ESTree } from "vite";

import type { ElementOptions, PropKind } from "../shared/element.ts";
import { checkPropNames } from "../shared/prop-names.ts";
import { importedNames } from "./ast.ts";
import { entries } from "./entries.ts";
import { CompileError } from "./errors.ts";

/**
 * ファイルのトップレベルで宣言した 1 つの型の名前に対応する、type か interface の宣言を表す。
 * 同じ名前を type と interface の両方で宣言したときは、先に宣言した方を表す。
 */
type Declared =
  | { readonly kind: "alias"; readonly declaration: ESTree.TSTypeAliasDeclaration }
  | {
      readonly kind: "interface";
      /** 同じ名前の interface の宣言のすべてのメンバーである。 */
      readonly members: readonly ESTree.TSSignature[];
      /** 同じ名前の interface の宣言のどれかが extends を持つかどうかである。 */
      readonly extended: boolean;
    };

/** Props の型を解析するときに参照する、ファイルの中の型の名前を表す。 */
interface Helpers {
  /** `Props` の名前である。 */
  readonly props: ReadonlySet<string>;
  /** `Slot` の名前である。 */
  readonly slot: ReadonlySet<string>;
  /** ファイルのトップレベルで宣言した type と interface の、名前ごとの宣言である。 */
  readonly declared: ReadonlyMap<string, Declared>;
}

/** 解析できない理由を受け取り、ビルドのエラーを返す関数を表す。 */
type Fail = (message: string) => CompileError;

/** Props の型のメンバー `members` と、要素がフォームの部品かどうか `form` から、要素を登録するときの設定を返す。 */
export function optionsOf(members: ReadonlyMap<string, PropMember>, form: boolean): ElementOptions {
  const props = Object.fromEntries([...members].map(([name, { kind }]) => [name, kind]));
  return form ? { props, form: true } : { props };
}

/** Props の型の 1 つのメンバーの、分類と宣言を表す。 */
export interface PropMember {
  readonly kind: PropKind;
  readonly signature: ESTree.TSPropertySignature | ESTree.TSMethodSignature;
}

/**
 * 要素の関数 `fn` の第 1 引数の型注釈を解析し、Props の型のメンバーの分類と宣言を、名前ごとに宣言した順で返す。
 * `children` の分類は `slot` である。
 */
export function propMembers(
  program: ESTree.Program,
  fn: ESTree.Function,
  file: string,
): ReadonlyMap<string, PropMember> {
  const fail: Fail = (message) => new CompileError(`${file}: ${message}`);
  const [param] = fn.params;
  if (!param) return new Map();
  if (param.type !== "Identifier") {
    throw fail(
      "要素の関数の第 1 引数は、props のような 1 つの名前で受け取ってください。分割代入、既定値、残余引数は使用できません。",
    );
  }
  const annotation = param.typeAnnotation?.typeAnnotation;
  if (!annotation) {
    throw fail(
      "要素の関数の第 1 引数に、Props の型注釈を記述してください。props を受け取る要素は、TypeScript のファイル（.tsx）に記述してください。",
    );
  }
  const members = propsMembers(annotation, helpersOf(program), fail);
  const errors = checkPropNames([...members.keys()]);
  if (errors.length > 0) throw fail(errors.join("\n"));
  return members;
}

/** Props の型注釈 `type` が表す型リテラルの、メンバーの名前と、分類と宣言を返す。 */
function propsMembers(type: ESTree.TSType, helpers: Helpers, fail: Fail): Map<string, PropMember> {
  const unwrap = (reference: ESTree.TSTypeReference) => {
    const argument = reference.typeArguments?.params[0];
    if (argument?.type !== "TSTypeLiteral") {
      throw fail("Props<T> の T には、型リテラルを記述してください。");
    }
    return classifyMembers(argument.members, helpers, fail);
  };
  const isHelper = (reference: ESTree.TSType): reference is ESTree.TSTypeReference =>
    reference.type === "TSTypeReference" &&
    reference.typeName.type === "Identifier" &&
    helpers.props.has(reference.typeName.name);
  if (isHelper(type)) return unwrap(type);
  const aliased = aliasedType(type, helpers);
  if (aliased && isHelper(aliased)) return unwrap(aliased);
  const members = membersOf(type, helpers);
  if (members === undefined) {
    throw fail(
      "Props の型には、型リテラルか、同じファイルで宣言した type か interface の名前か、rinka の Props<T> で包んだ型リテラルを記述してください。",
    );
  }
  return classifyMembers(members, helpers, fail);
}

/** `type` が同じファイルで宣言した type の名前なら、その本体の型を返す。 */
function aliasedType(type: ESTree.TSType, helpers: Helpers): ESTree.TSType | undefined {
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return undefined;
  const declared = helpers.declared.get(type.typeName.name);
  return declared?.kind === "alias" ? declared.declaration.typeAnnotation : undefined;
}

/**
 * `type` が型リテラルか、同じファイルで宣言した type か interface の名前なら、その型のメンバーを返す。
 * type の本体が型リテラルでないときと、interface が extends を持つときは、`undefined` を返す。
 */
function membersOf(
  type: ESTree.TSType,
  helpers: Helpers,
): readonly ESTree.TSSignature[] | undefined {
  if (type.type === "TSTypeLiteral") return type.members;
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return undefined;
  const declared = helpers.declared.get(type.typeName.name);
  if (declared?.kind === "interface") return declared.extended ? undefined : declared.members;
  const aliased = declared?.declaration.typeAnnotation;
  return aliased?.type === "TSTypeLiteral" ? aliased.members : undefined;
}

/** ファイルの中で宣言した型を、Props の型と同じ規則で解決する関数を表す。 */
export interface FileTypes {
  /** 型リテラルか、同じファイルで宣言した type か interface の名前のメンバーを返す。それ以外の形と、extends を持つ interface には `undefined` を返す。 */
  readonly members: (type: ESTree.TSType) => readonly ESTree.TSSignature[] | undefined;
  /** 括弧と、同じファイルで宣言した型引数の無い type の名前を、本体の型までたどって返す。 */
  readonly resolve: (type: ESTree.TSType) => ESTree.TSType;
}

/** ファイル `program` で宣言した型を解決する関数を返す。 */
export function fileTypes(program: ESTree.Program): FileTypes {
  const helpers = helpersOf(program);
  const resolve = (type: ESTree.TSType, seen: ReadonlySet<string> = new Set()): ESTree.TSType => {
    if (type.type === "TSParenthesizedType") return resolve(type.typeAnnotation, seen);
    if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return type;
    const { name } = type.typeName;
    const declared = helpers.declared.get(name);
    if (seen.has(name) || declared?.kind !== "alias" || declared.declaration.typeParameters) {
      return type;
    }
    return resolve(declared.declaration.typeAnnotation, new Set([...seen, name]));
  };
  return { members: (type) => membersOf(type, helpers), resolve: (type) => resolve(type) };
}

/** 型のメンバーの名前を返す。名前を識別子か文字列で記述していなければ `undefined` を返す。 */
export function memberName(member: ESTree.TSSignature): string | undefined {
  if (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature") {
    return undefined;
  }
  const { key } = member;
  if (!member.computed && key.type === "Identifier") return key.name;
  return key.type === "Literal" && typeof key.value === "string" ? key.value : undefined;
}

/** `rinka` から import した `Props` と `Slot` の、ファイルの中の名前と、ファイルで宣言した type と interface を返す。 */
function helpersOf(program: ESTree.Program): Helpers {
  const names = importedNames(program, entries.main);
  const declared = new Map<string, Declared>();
  for (const declaration of declarations(program)) {
    const { name } = declaration.id;
    const previous = declared.get(name);
    if (declaration.type === "TSTypeAliasDeclaration") {
      if (previous === undefined) declared.set(name, { kind: "alias", declaration });
    } else if (previous === undefined) {
      declared.set(name, {
        kind: "interface",
        members: declaration.body.body,
        extended: declaration.extends.length > 0,
      });
    } else if (previous.kind === "interface") {
      declared.set(name, {
        kind: "interface",
        members: [...previous.members, ...declaration.body.body],
        extended: previous.extended || declaration.extends.length > 0,
      });
    }
  }
  return {
    props: names.get("Props") ?? new Set(),
    slot: names.get("Slot") ?? new Set(),
    declared,
  };
}

/** ファイルのトップレベルで宣言した type と interface を返す。 */
function declarations(
  program: ESTree.Program,
): (ESTree.TSTypeAliasDeclaration | ESTree.TSInterfaceDeclaration)[] {
  return program.body.flatMap((statement) => {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    return declaration?.type === "TSTypeAliasDeclaration" ||
      declaration?.type === "TSInterfaceDeclaration"
      ? [declaration]
      : [];
  });
}

/** 型リテラルのメンバーを、名前と、分類と宣言の組にする。`children` は `slot` に分類する。 */
function classifyMembers(
  members: readonly ESTree.TSSignature[],
  helpers: Helpers,
  fail: Fail,
): Map<string, PropMember> {
  const classified = new Map<string, PropMember>();
  for (const member of members) {
    if (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature") {
      throw fail("Props の型には、プロパティとメソッドだけを宣言してください。");
    }
    const name = memberName(member);
    if (name === undefined) {
      throw fail("Props の型のメンバーの名前は、識別子か文字列で記述してください。");
    }
    classified.set(name, {
      kind: name === "children" ? "slot" : memberKind(member, helpers),
      signature: member,
    });
  }
  return classified;
}

/** メンバーの分類を返す。getter は戻り値の型で、setter は引数の型で分類する。 */
function memberKind(
  member: ESTree.TSPropertySignature | ESTree.TSMethodSignature,
  helpers: Helpers,
): PropKind {
  if (member.type === "TSPropertySignature") {
    return classify(member.typeAnnotation?.typeAnnotation, helpers);
  }
  if (member.kind === "get") return classify(member.returnType?.typeAnnotation, helpers);
  if (member.kind === "set") {
    const [param] = member.params;
    return classify(
      param?.type === "Identifier" ? param.typeAnnotation?.typeAnnotation : undefined,
      helpers,
    );
  }
  return "function";
}

/** 型の記述から、メンバーの分類を返す。`seen` は、解決している途中の type の名前である。 */
function classify(
  type: ESTree.TSType | undefined,
  helpers: Helpers,
  seen: ReadonlySet<string> = new Set(),
): PropKind {
  if (type === undefined) return "unknown";
  if (type.type === "TSStringKeyword") return "string";
  if (type.type === "TSNumberKeyword") return "number";
  if (type.type === "TSBooleanKeyword") return "boolean";
  if (type.type === "TSFunctionType") return "function";
  if (type.type === "TSParenthesizedType") return classify(type.typeAnnotation, helpers, seen);
  if (type.type === "TSTypeOperator" && type.operator === "readonly") {
    return classify(type.typeAnnotation, helpers, seen);
  }
  if (type.type === "TSTemplateLiteralType") return type.types.length === 0 ? "string" : "unknown";
  if (type.type === "TSTypeReference") {
    if (isSlotType(type.typeName, helpers)) return "slot";
    return type.typeName.type === "Identifier"
      ? referenceKind(type.typeName.name, helpers, seen)
      : "unknown";
  }
  if (type.type === "TSLiteralType") return literalKind(type.literal);
  if (type.type === "TSUnionType") {
    const kinds = new Set(
      type.types
        .filter((member) => member.type !== "TSUndefinedKeyword" && member.type !== "TSNullKeyword")
        .map((member) => classify(member, helpers, seen)),
    );
    const [kind] = kinds;
    return kinds.size === 1 && kind !== undefined ? kind : "unknown";
  }
  return objectTypes.has(type.type) ? "object" : "unknown";
}

/**
 * 同じファイルで宣言した type と interface と、値がオブジェクトになる組み込みの型の名前 `name` の分類を返す。
 * interface は、メンバーが 1 つ以上あり、すべてが呼び出しのシグネチャなら関数に、それ以外はオブジェクトに分類する。
 * type の別名の本体では、別名の型引数の名前を、解決できない名前として扱う。
 */
function referenceKind(name: string, helpers: Helpers, seen: ReadonlySet<string>): PropKind {
  if (seen.has(name)) return "unknown";
  const declared = helpers.declared.get(name);
  if (declared?.kind === "interface") {
    const callable =
      declared.members.length > 0 &&
      declared.members.every((member) => member.type === "TSCallSignatureDeclaration");
    return callable ? "function" : "object";
  }
  if (declared?.kind === "alias") {
    const { declaration } = declared;
    const params = declaration.typeParameters?.params.map((param) => param.name.name) ?? [];
    return classify(declaration.typeAnnotation, helpers, new Set([...seen, name, ...params]));
  }
  return objectReferences.has(name) ? "object" : "unknown";
}

/** 値がオブジェクトになる組み込みの型の名前である。 */
const objectReferences: ReadonlySet<string> = new Set([
  "Array",
  "ReadonlyArray",
  "Record",
  "Map",
  "ReadonlyMap",
  "Set",
  "ReadonlySet",
  "Date",
]);

/** 値がオブジェクトになる型の記述の種類である。 */
const objectTypes: ReadonlySet<string> = new Set([
  "TSTypeLiteral",
  "TSArrayType",
  "TSTupleType",
  "TSObjectKeyword",
  "TSMappedType",
]);

/** リテラル型の分類を返す。 */
function literalKind(literal: ESTree.TSLiteralType["literal"]): PropKind {
  if (literal.type === "UnaryExpression") {
    const { argument } = literal;
    return literal.operator === "-" &&
      argument.type === "Literal" &&
      typeof argument.value === "number"
      ? "number"
      : "unknown";
  }
  if (literal.type === "TemplateLiteral") {
    return literal.expressions.length === 0 ? "string" : "unknown";
  }
  if (literal.type !== "Literal") return "unknown";
  const kind = typeof literal.value;
  return kind === "string" || kind === "number" || kind === "boolean" ? kind : "unknown";
}

/** 型の名前が、`JSX.Element` か、`rinka` から import した `Slot` かどうかを返す。 */
function isSlotType(name: ESTree.TSTypeName, helpers: Helpers): boolean {
  if (name.type === "Identifier") return helpers.slot.has(name.name);
  return (
    name.type === "TSQualifiedName" &&
    name.left.type === "Identifier" &&
    name.left.name === "JSX" &&
    name.right.name === "Element"
  );
}
