import type { MagicString, SourceMap } from "magic-string";
import { parseSync, type ESTree } from "vite";

import { ParseError } from "./errors.ts";

/** 変換するソースの言語を表す。 */
export type Lang = "ts" | "tsx" | "js" | "jsx";

/** 拡張子ごとの、変換する言語である。 */
export const langs: Readonly<Record<string, Lang>> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
};

/** oxc のパーサーが返す AST のノードを表す。 */
export type Node = ESTree.Node;

/** 関数のノードを表す。 */
export type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

/** `value` が AST のノードかどうかを返す。 */
function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

/** `node` の子のノードを返す。 */
export function children(node: Node): Node[] {
  const found: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) found.push(item);
    } else if (isNode(value)) {
      found.push(value);
    }
  }
  return found;
}

/** `node` と、その子孫のノードを、親から順に `visit` に渡す。`skip` が真を返すノードと、その子孫は渡さない。 */
export function walk(
  node: Node,
  visit: (node: Node) => void,
  skip: (node: Node) => boolean = () => false,
): void {
  if (skip(node)) return;
  visit(node);
  for (const child of children(node)) walk(child, visit, skip);
}

/** `node` が関数のノードかどうかを返す。 */
export function isFunction(node: Node): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** import と export の名前のノードが表す名前を返す。 */
export function moduleExportName(node: ESTree.ModuleExportName): string {
  return node.type === "Literal" ? node.value : node.name;
}

/** `code` の中の各行の先頭の位置を返す。 */
export function lineStarts(code: string): number[] {
  const starts = [0];
  for (let index = code.indexOf("\n"); index !== -1; index = code.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

/** `offset` の位置を、1 から数えた `行:列` の文字列にする。 */
export function lineColumn(starts: readonly number[], offset: number): string {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return `${low + 1}:${offset - (starts[low] ?? 0) + 1}`;
}

/** 位置の範囲を持つ値を表す。 */
interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * `node` の範囲を `open` と `close` で囲む。
 * 内側のノードから順に呼び出すと、外側のノードを囲む文字列は、内側のノードを囲む文字列の外に並ぶ。
 */
export function surround(output: MagicString, node: Span, open: string, close: string): void {
  output.prependRight(node.start, open);
  output.appendLeft(node.end, close);
}

/**
 * `node` の最初の文字（オブジェクトやブロックの `{`）の直後に `text` を挿入する。
 * `text` は、`node` の内側の最初の子を `surround` で囲む文字列より前に並ぶ。同じ `node` に 2 回呼び出すと、後の `text` は前の `text` の後ろに並ぶ。
 */
export function insertInside(output: MagicString, node: Span, text: string): void {
  output.appendLeft(node.start + 1, text);
}

/** `node` の直後に `text` を挿入する。`text` は、`node` の末尾に `surround` で挿入した文字列より後ろに並ぶ。 */
export function follow(output: MagicString, node: Span, text: string): void {
  output.appendRight(node.end, text);
}

/** `source` から名前で import した指定子を、import した名前ごとに、ファイルの中の名前の集合にして返す。 */
export function importedNames(
  program: ESTree.Program,
  source: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  const names = new Map<string, Set<string>>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== source) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier") continue;
      const imported = moduleExportName(specifier.imported);
      const locals = names.get(imported) ?? new Set();
      locals.add(specifier.local.name);
      names.set(imported, locals);
    }
  }
  return names;
}

/** 解析するモジュールを表す。 */
export interface ModuleSource {
  /** モジュールのパスである。ソースマップは、このパスのファイルを指す。 */
  readonly id: string;
  /** ファイルのパスである。プロジェクトのルートからの相対パスを、`/` で区切って記述する。エラーの文言に表示する。 */
  readonly file: string;
  readonly lang: Lang;
}

/** `code` を ES モジュールとして解析する。式を囲む括弧は `ParenthesizedExpression` のノードにする。構文の誤りがあれば `ParseError` を投げる。 */
export function parseModule(code: string, { id, file, lang }: ModuleSource): ESTree.Program {
  const { program, errors } = parseSync(id, code, { lang, sourceType: "module" });
  const [error] = errors;
  if (error) throw new ParseError(`${file} を解析できません: ${error.message}`);
  return program;
}

/** 式を囲む括弧を外したノードを返す。 */
export function unwrap(node: Node): Node {
  let current = node;
  while (current.type === "ParenthesizedExpression") current = current.expression;
  return current;
}

/** 括弧と、`as` と `satisfies` の型の記述を外した式を返す。 */
export function withoutTypes(node: Node): Node {
  let current = node;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression"
  ) {
    current = current.expression;
  }
  return current;
}

/** 分割代入のパターン `pattern` が、`name` という名前の変数を宣言するかどうかを返す。 */
export function binds(
  pattern: ESTree.BindingPattern | ESTree.BindingRestElement,
  name: string,
): boolean {
  switch (pattern.type) {
    case "Identifier":
      return pattern.name === name;
    case "ObjectPattern":
      return pattern.properties.some((property) =>
        binds(property.type === "RestElement" ? property : property.value, name),
      );
    case "ArrayPattern":
      return pattern.elements.some((element) => element !== null && binds(element, name));
    case "AssignmentPattern":
      return binds(pattern.left, name);
    case "RestElement":
      return binds(pattern.argument, name);
  }
}

/** トップレベルの変数の宣言を表す。`exported` は、`export` を付けた宣言なら真である。 */
export interface TopLevelVariable {
  readonly declaration: ESTree.VariableDeclaration;
  readonly exported: boolean;
}

/** トップレベルの変数の宣言を、`export` を付けたものも含めて、ソースの順に返す。 */
export function topLevelVariables(program: ESTree.Program): TopLevelVariable[] {
  return program.body.flatMap((statement): TopLevelVariable[] => {
    if (statement.type === "VariableDeclaration")
      return [{ declaration: statement, exported: false }];
    if (
      statement.type === "ExportNamedDeclaration" &&
      statement.declaration?.type === "VariableDeclaration"
    ) {
      return [{ declaration: statement.declaration, exported: true }];
    }
    return [];
  });
}

/** 子に値の式を持つ、TypeScript の構文のノードの種類である。 */
const valueTsNodes = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "TSEnumDeclaration",
  "TSEnumBody",
  "TSEnumMember",
  "TSImportEqualsDeclaration",
  "TSQualifiedName",
  "TSModuleDeclaration",
  "TSModuleBlock",
  "TSExportAssignment",
  "TSParameterProperty",
]);

/** 子の識別子が、常に名前として現れて変数を参照しない、ノードの種類である。 */
const nameParents = new Set([
  "JSXAttribute",
  "JSXNamespacedName",
  "MetaProperty",
  "ImportSpecifier",
  "ImportDefaultSpecifier",
  "ImportNamespaceSpecifier",
  "LabeledStatement",
  "BreakStatement",
  "ContinueStatement",
]);

/** 識別子が名前として現れ、変数を参照しない位置かどうかを返す。`key` は、親のノードで識別子を持つプロパティの名前である。 */
function isNamePosition(parent: Node, key: string): boolean {
  if (
    parent.type === "Property" ||
    parent.type === "MethodDefinition" ||
    parent.type === "PropertyDefinition" ||
    parent.type === "AccessorProperty"
  ) {
    return key === "key" && !parent.computed;
  }
  if (parent.type === "MemberExpression") return key === "property" && !parent.computed;
  if (parent.type === "JSXMemberExpression") return key === "property";
  if (parent.type === "ExportSpecifier") return key === "exported";
  if (parent.type === "TSQualifiedName") return key === "right";
  if (parent.type === "TSImportEqualsDeclaration") return key === "id";
  return nameParents.has(parent.type);
}

/** 識別子のノードを表す。 */
export type NameNode = Extract<Node, { type: "Identifier" | "JSXIdentifier" }>;

/**
 * `root` の中で、値として変数を参照しうる識別子を、ソースの順に `visit` に渡す。
 * オブジェクトのキー、プロパティの名前、import の指定子、型の記述の中の識別子は渡さない。`skip` が真を返すノードの中は確認しない。
 * 宣言する位置の識別子も渡すので、同じ名前の変数を内側の関数で宣言すると、その識別子も渡す。
 */
export function forEachReference(
  root: Node,
  skip: (node: Node) => boolean,
  visit: (node: NameNode) => void,
): void {
  const walkNode = (node: Node, parent: Node | undefined, key: string): void => {
    if (skip(node)) return;
    if (node.type.startsWith("TS") && !valueTsNodes.has(node.type)) return;
    if (
      (node.type === "Identifier" || node.type === "JSXIdentifier") &&
      !(parent && isNamePosition(parent, key))
    ) {
      visit(node);
    }
    for (const [childKey, value] of Object.entries(node)) {
      if (childKey === "parent") continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) walkNode(item, node, childKey);
      } else if (isNode(value)) {
        walkNode(value, node, childKey);
      }
    }
  };
  walkNode(root, undefined, "");
}

/** 変換したコードと、元のコードへのソースマップを表す。 */
export interface Transformed {
  readonly code: string;
  readonly map: SourceMap;
}
