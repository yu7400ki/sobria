import type { ESTree } from "vite";

import { binds, forEachReference, isFunction, walk, withoutTypes, type Node } from "./ast.ts";
import { CompileError } from "./errors.ts";
import type { CtxParam } from "./props.ts";

/**
 * 要素の関数 `fn` が、2 番目の引数の ctx `param` の `form` を使用するかどうかを返す。
 * ctx を、`ctx[key]` の形でないプロパティの参照と、キーが識別子で残余の要素を持たない分割代入以外で使用していれば、ビルドのエラーにする。
 * 内側の関数とブロックで同じ名前を宣言した変数は、ctx として扱わない。
 */
export function usesForm(fn: ESTree.Function, param: CtxParam | undefined, file: string): boolean {
  if (param === undefined) return false;
  const error = () =>
    new CompileError(
      `${file}: 要素の関数の ${param.type === "Identifier" ? param.name : "ctx"} は、ctx.form のようなプロパティの参照か、const { form } = ctx のような分割代入で使用してください。要素がフォームの部品かどうかを、ctx の使い方からビルドで判別するためです。`,
    );
  if (param.type === "ObjectPattern") return keysOf(param, error).includes("form");
  const { name } = param;
  const body = fn.body;
  if (!body) return false;
  const shadowed = (node: Node) => node !== body && declares(node, name);
  /** 式 `node` から括弧と型の記述を外したものが ctx の識別子なら、その識別子を返す。 */
  const ctxOf = (node: Node) => {
    let current = withoutTypes(node);
    while (current.type === "TSNonNullExpression") current = withoutTypes(current.expression);
    return current.type === "Identifier" && current.name === name ? current : undefined;
  };
  const allowed = new Set<Node>();
  let form = false;
  walk(
    body,
    (node) => {
      if (node.type === "MemberExpression" && !node.computed) {
        const ctx = ctxOf(node.object);
        if (!ctx) return;
        allowed.add(ctx);
        if (node.property.type === "Identifier" && node.property.name === "form") form = true;
      } else if (
        node.type === "VariableDeclarator" &&
        node.init &&
        node.id.type === "ObjectPattern"
      ) {
        const ctx = ctxOf(node.init);
        if (!ctx) return;
        allowed.add(ctx);
        if (keysOf(node.id, error).includes("form")) form = true;
      }
    },
    shadowed,
  );
  forEachReference(body, shadowed, (node) => {
    if (node.type === "Identifier" && node.name === name && !allowed.has(node)) throw error();
  });
  return form;
}

/** 分割代入のパターン `pattern` のキーの名前を返す。キーが識別子でないか、残余の要素があれば、`error` が返す例外を投げる。 */
function keysOf(pattern: ESTree.ObjectPattern, error: () => CompileError): string[] {
  return pattern.properties.map((property) => {
    if (
      property.type === "RestElement" ||
      property.computed ||
      property.key.type !== "Identifier"
    ) {
      throw error();
    }
    return property.key.name;
  });
}

/** 関数、ブロック、`catch` 節、`for` 文の `node` が、そのスコープに `name` の変数を宣言するかどうかを返す。 */
function declares(node: Node, name: string): boolean {
  if (isFunction(node)) {
    return (
      (node.type !== "ArrowFunctionExpression" && node.id?.name === name) ||
      node.params.some((param) => {
        if (param.type === "TSParameterProperty") return binds(param.parameter, name);
        return binds(param.type === "RestElement" ? param.argument : param, name);
      })
    );
  }
  if (node.type === "BlockStatement" || node.type === "StaticBlock") {
    return node.body.some((statement) => declaresInStatement(statement, name));
  }
  if (node.type === "CatchClause") return node.param !== null && binds(node.param, name);
  if (node.type === "ForStatement") {
    return node.init?.type === "VariableDeclaration" && declaresInStatement(node.init, name);
  }
  if (node.type === "ForInStatement" || node.type === "ForOfStatement") {
    return node.left.type === "VariableDeclaration" && declaresInStatement(node.left, name);
  }
  return false;
}

/** 文 `statement` が `name` の変数、関数、クラスを宣言するかどうかを返す。 */
function declaresInStatement(statement: Node, name: string): boolean {
  if (statement.type === "VariableDeclaration") {
    return statement.declarations.some((declarator) => binds(declarator.id, name));
  }
  if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
    return statement.id?.name === name;
  }
  return false;
}
