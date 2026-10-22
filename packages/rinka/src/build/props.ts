import type { ESTree } from "vite";

import type { AttributeType, ElementOptions } from "../shared/element.ts";
import { checkPropNames } from "../shared/prop-names.ts";
import { moduleExportName } from "./ast.ts";

/** Props のメンバーの分類を表す。 */
type Kind = AttributeType | "function" | "slot" | "object";

/** 要素のファイルの Props の型を解析できないことを表す。 */
export class PropsError extends Error {}

/**
 * 要素の関数 `fn` の第 1 引数の型注釈を解析し、要素を登録するときの設定を返す。
 * `program` は、`fn` を宣言したファイルである。
 */
export function analyzeProps(program: ESTree.Program, fn: ESTree.Function): ElementOptions {
  const [param] = fn.params;
  if (!param) return { props: [] };
  if (param.type !== "Identifier") {
    throw new PropsError(
      "要素の関数の第 1 引数は、分割代入にせずに props のような名前で受け取ってください。",
    );
  }
  const annotation = param.typeAnnotation?.typeAnnotation;
  if (!annotation) return { props: [] };
  const members = propsMembers(program, annotation);
  const props: string[] = [];
  const types: Record<string, AttributeType> = {};
  const slots: string[] = [];
  const functionProps: string[] = [];
  for (const [name, kind] of members) {
    if (kind === "slot") {
      if (name !== "children") slots.push(name);
      continue;
    }
    props.push(name);
    if (kind === "function") functionProps.push(name);
    else if (kind !== "object") types[name] = kind;
  }
  const errors = checkPropNames([...members.keys()]);
  if (errors.length > 0) throw new PropsError(errors.join("\n"));
  return {
    props,
    ...(Object.keys(types).length > 0 && { types }),
    ...(slots.length > 0 && { slots }),
    ...(functionProps.length > 0 && { functionProps }),
  };
}

/** Props の型注釈 `type` が表す型リテラルの、メンバーの名前と分類を返す。 */
function propsMembers(program: ESTree.Program, type: ESTree.TSType): Map<string, Kind> {
  const unsupported = new PropsError(
    "Props の型には、型リテラルか、同じファイルで宣言した type か interface の名前か、rinka の Props<T> で包んだ型リテラルを記述してください。",
  );
  if (type.type === "TSTypeLiteral") return classifyMembers(type.members);
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") throw unsupported;
  const { name } = type.typeName;
  if (propsHelpers(program).has(name)) return helperMembers(type);
  for (const declaration of declarations(program)) {
    if (declaration.id.name !== name) continue;
    if (declaration.type === "TSInterfaceDeclaration") {
      if (declaration.extends.length > 0) throw unsupported;
      return classifyMembers(declaration.body.body);
    }
    const aliased = declaration.typeAnnotation;
    if (aliased.type === "TSTypeLiteral") return classifyMembers(aliased.members);
    if (
      aliased.type === "TSTypeReference" &&
      aliased.typeName.type === "Identifier" &&
      propsHelpers(program).has(aliased.typeName.name)
    ) {
      return helperMembers(aliased);
    }
    throw unsupported;
  }
  throw unsupported;
}

/** `Props<T>` の `T` の型リテラルの、メンバーの名前と分類を返す。 */
function helperMembers(reference: ESTree.TSTypeReference): Map<string, Kind> {
  const argument = reference.typeArguments?.params[0];
  if (argument?.type !== "TSTypeLiteral") {
    throw new PropsError("Props<T> の T には、型リテラルを記述してください。");
  }
  return classifyMembers(argument.members);
}

/** `rinka` から import した `Props` の、ファイルの中の名前を返す。 */
function propsHelpers(program: ESTree.Program): Set<string> {
  const names = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== "rinka") continue;
    for (const specifier of statement.specifiers) {
      if (
        specifier.type === "ImportSpecifier" &&
        moduleExportName(specifier.imported) === "Props"
      ) {
        names.add(specifier.local.name);
      }
    }
  }
  return names;
}

/** ファイルのトップレベルで宣言した type と interface を返す。 */
function* declarations(
  program: ESTree.Program,
): Generator<ESTree.TSTypeAliasDeclaration | ESTree.TSInterfaceDeclaration> {
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (
      declaration?.type === "TSTypeAliasDeclaration" ||
      declaration?.type === "TSInterfaceDeclaration"
    ) {
      yield declaration;
    }
  }
}

/** 型リテラルのメンバーを、名前と分類の組にする。 */
function classifyMembers(members: readonly ESTree.TSSignature[]): Map<string, Kind> {
  const classified = new Map<string, Kind>();
  for (const member of members) {
    if (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature") {
      throw new PropsError("Props の型には、プロパティとメソッドだけを宣言してください。");
    }
    const name = memberName(member);
    if (member.type === "TSMethodSignature") classified.set(name, "function");
    else classified.set(name, classify(member.typeAnnotation?.typeAnnotation));
  }
  return classified;
}

/** メンバーの名前を返す。 */
function memberName(member: ESTree.TSPropertySignature | ESTree.TSMethodSignature): string {
  const { key } = member;
  if (!member.computed && key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  throw new PropsError("Props の型のメンバーの名前は、識別子か文字列で記述してください。");
}

/** 型の記述から、メンバーの分類を返す。 */
function classify(type: ESTree.TSType | undefined): Kind {
  if (type === undefined) return "object";
  if (type.type === "TSStringKeyword") return "string";
  if (type.type === "TSNumberKeyword") return "number";
  if (type.type === "TSBooleanKeyword") return "boolean";
  if (type.type === "TSFunctionType") return "function";
  if (type.type === "TSParenthesizedType") return classify(type.typeAnnotation);
  if (type.type === "TSTypeReference") return isSlotType(type.typeName) ? "slot" : "object";
  if (type.type === "TSLiteralType") {
    const { literal } = type;
    if (literal.type !== "Literal") return "object";
    const kind = typeof literal.value;
    return kind === "string" || kind === "number" || kind === "boolean" ? kind : "object";
  }
  if (type.type === "TSUnionType") {
    const kinds = new Set(
      type.types
        .filter((member) => member.type !== "TSUndefinedKeyword" && member.type !== "TSNullKeyword")
        .map(classify),
    );
    const [kind] = kinds;
    return kinds.size === 1 && kind !== undefined ? kind : "object";
  }
  return "object";
}

/** 型の名前が `JSX.Element` か `Slot` かどうかを返す。 */
function isSlotType(name: ESTree.TSTypeName): boolean {
  if (name.type === "Identifier") return name.name === "Slot";
  return (
    name.type === "TSQualifiedName" &&
    name.left.type === "Identifier" &&
    name.left.name === "JSX" &&
    name.right.name === "Element"
  );
}
