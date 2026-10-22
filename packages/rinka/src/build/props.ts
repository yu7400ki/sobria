import type { ESTree } from "vite";

import type { AttributeType, ElementOptions } from "../shared/element.ts";
import { checkPropNames } from "../shared/prop-names.ts";
import { importedNames } from "./ast.ts";
import { entries } from "./entries.ts";
import { CompileError } from "./errors.ts";

/** Props のメンバーの分類を表す。 */
type Kind = AttributeType | "function" | "slot" | "object";

/** `rinka` から import した型の、ファイルの中の名前を表す。 */
interface Helpers {
  /** `Props` の名前である。 */
  readonly props: ReadonlySet<string>;
  /** `Slot` の名前である。 */
  readonly slot: ReadonlySet<string>;
}

/** 解析できない理由を受け取り、ビルドのエラーを返す関数を表す。 */
type Fail = (message: string) => CompileError;

/**
 * 要素の関数 `fn` の第 1 引数の型注釈を解析し、要素を登録するときの設定を返す。
 * `program` は `fn` を宣言したファイルで、`file` はそのパスである。
 */
export function analyzeProps(
  program: ESTree.Program,
  fn: ESTree.Function,
  file: string,
): ElementOptions {
  const fail: Fail = (message) => new CompileError(`${file}: ${message}`);
  const [param] = fn.params;
  if (!param) return { props: [] };
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
  const members = propsMembers(program, annotation, rinkaTypes(program), fail);
  const errors = checkPropNames([...members.keys()]);
  if (errors.length > 0) throw fail(errors.join("\n"));
  const types: Record<string, AttributeType> = {};
  const slots: string[] = [];
  const functionProps: string[] = [];
  for (const [name, kind] of members) {
    if (kind === "slot") {
      if (name !== "children") slots.push(name);
    } else if (kind === "function") {
      functionProps.push(name);
    } else if (kind !== "object") {
      types[name] = kind;
    }
  }
  return {
    props: [...members.keys()],
    ...(Object.keys(types).length > 0 && { types }),
    ...(slots.length > 0 && { slots }),
    ...(functionProps.length > 0 && { functionProps }),
  };
}

/** Props の型注釈 `type` が表す型リテラルの、メンバーの名前と分類を返す。 */
function propsMembers(
  program: ESTree.Program,
  type: ESTree.TSType,
  helpers: Helpers,
  fail: Fail,
): Map<string, Kind> {
  const classifyAll = (members: readonly ESTree.TSSignature[]) =>
    classifyMembers(members, helpers, fail);
  const unwrap = (reference: ESTree.TSTypeReference) => {
    const argument = reference.typeArguments?.params[0];
    if (argument?.type !== "TSTypeLiteral") {
      throw fail("Props<T> の T には、型リテラルを記述してください。");
    }
    return classifyAll(argument.members);
  };
  const isHelper = (reference: ESTree.TSTypeReference) =>
    reference.typeName.type === "Identifier" && helpers.props.has(reference.typeName.name);
  const unsupported = fail(
    "Props の型には、型リテラルか、同じファイルで宣言した type か interface の名前か、rinka の Props<T> で包んだ型リテラルを記述してください。",
  );
  if (type.type === "TSTypeLiteral") return classifyAll(type.members);
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") throw unsupported;
  if (isHelper(type)) return unwrap(type);
  const { name } = type.typeName;
  const found = declarations(program).filter((declaration) => declaration.id.name === name);
  const [first] = found;
  if (first?.type === "TSTypeAliasDeclaration") {
    const aliased = first.typeAnnotation;
    if (aliased.type === "TSTypeLiteral") return classifyAll(aliased.members);
    if (aliased.type === "TSTypeReference" && isHelper(aliased)) return unwrap(aliased);
    throw unsupported;
  }
  const interfaces = found.filter((declaration) => declaration.type === "TSInterfaceDeclaration");
  if (interfaces.length === 0 || interfaces.some((declaration) => declaration.extends.length > 0)) {
    throw unsupported;
  }
  return classifyAll(interfaces.flatMap((declaration) => declaration.body.body));
}

/** `rinka` から import した `Props` と `Slot` の、ファイルの中の名前を返す。 */
function rinkaTypes(program: ESTree.Program): Helpers {
  const names = importedNames(program, entries.main);
  return { props: names.get("Props") ?? new Set(), slot: names.get("Slot") ?? new Set() };
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

/** 型リテラルのメンバーを、名前と分類の組にする。 */
function classifyMembers(
  members: readonly ESTree.TSSignature[],
  helpers: Helpers,
  fail: Fail,
): Map<string, Kind> {
  const classified = new Map<string, Kind>();
  for (const member of members) {
    if (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature") {
      throw fail("Props の型には、プロパティとメソッドだけを宣言してください。");
    }
    const { key } = member;
    let name: string | undefined;
    if (!member.computed && key.type === "Identifier") name = key.name;
    else if (key.type === "Literal" && typeof key.value === "string") name = key.value;
    if (name === undefined) {
      throw fail("Props の型のメンバーの名前は、識別子か文字列で記述してください。");
    }
    classified.set(name, memberKind(member, helpers));
  }
  return classified;
}

/** メンバーの分類を返す。getter は戻り値の型で、setter は引数の型で分類する。 */
function memberKind(
  member: ESTree.TSPropertySignature | ESTree.TSMethodSignature,
  helpers: Helpers,
): Kind {
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

/** 型の記述から、メンバーの分類を返す。 */
function classify(type: ESTree.TSType | undefined, helpers: Helpers): Kind {
  if (type === undefined) return "object";
  if (type.type === "TSStringKeyword") return "string";
  if (type.type === "TSNumberKeyword") return "number";
  if (type.type === "TSBooleanKeyword") return "boolean";
  if (type.type === "TSFunctionType") return "function";
  if (type.type === "TSParenthesizedType") return classify(type.typeAnnotation, helpers);
  if (type.type === "TSTemplateLiteralType") return type.types.length === 0 ? "string" : "object";
  if (type.type === "TSTypeReference") {
    return isSlotType(type.typeName, helpers) ? "slot" : "object";
  }
  if (type.type === "TSLiteralType") return literalKind(type.literal);
  if (type.type === "TSUnionType") {
    const kinds = new Set(
      type.types
        .filter((member) => member.type !== "TSUndefinedKeyword" && member.type !== "TSNullKeyword")
        .map((member) => classify(member, helpers)),
    );
    const [kind] = kinds;
    return kinds.size === 1 && kind !== undefined ? kind : "object";
  }
  return "object";
}

/** リテラル型の分類を返す。 */
function literalKind(literal: ESTree.TSLiteralType["literal"]): Kind {
  if (literal.type === "UnaryExpression") {
    const { argument } = literal;
    return literal.operator === "-" &&
      argument.type === "Literal" &&
      typeof argument.value === "number"
      ? "number"
      : "object";
  }
  if (literal.type === "TemplateLiteral") {
    return literal.expressions.length === 0 ? "string" : "object";
  }
  if (literal.type !== "Literal") return "object";
  const kind = typeof literal.value;
  return kind === "string" || kind === "number" || kind === "boolean" ? kind : "object";
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
