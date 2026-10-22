import { MagicString } from "magic-string";
import { parseSync, type ESTree } from "vite";

import { isEventProp } from "../shared/names.ts";
import { children, isFunction, moduleExportName, type Node } from "./ast.ts";
import type { Transformed } from "./compiler.ts";
import { CompileError } from "./errors.ts";

/** `rinka/jsx-runtime` から import した名前を表す。 */
interface Runtime {
  /** `jsx` と `jsxs` の、ファイルの中の名前である。 */
  readonly calls: ReadonlySet<string>;
  /** `Fragment` の、ファイルの中の名前である。 */
  readonly fragments: ReadonlySet<string>;
}

/**
 * oxc が JSX を変換した後のコードの、`rinka/jsx-runtime` の呼び出しに規則を適用する。
 * ネイティブのタグと Fragment の属性と子は、関数呼び出しかプロパティ参照を含む式を関数で包む。
 * コンポーネントに渡す props と children は、リテラルと関数を除いて getter にする。
 */
export function transformJsx(code: string, file: string): Transformed {
  const { program, errors } = parseSync(file, code, { lang: "js", sourceType: "module" });
  const [error] = errors;
  if (error) throw new CompileError(`${file} を解析できません: ${error.message}`);
  const output = new MagicString(code);
  const runtime = runtimeNames(program, file);
  if (runtime.calls.size > 0) {
    // 内側の呼び出しから順に書き換えるので、開く括弧は prependRight で、閉じる括弧は appendLeft で挿入する
    const visit = (node: Node): void => {
      for (const child of children(node)) visit(child);
      if (isJsxCall(node, runtime)) applyRules(node, runtime, output, code);
    };
    visit(program);
  }
  return {
    code: output.toString(),
    map: output.generateMap({ hires: true, source: file, includeContent: true }),
  };
}

/** `rinka/jsx-runtime` から import した名前を返す。 */
function runtimeNames(program: ESTree.Program, file: string): Runtime {
  const calls = new Set<string>();
  const fragments = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier") continue;
      const imported = moduleExportName(specifier.imported);
      if (statement.source.value === "rinka" && imported === "createElement") {
        throw new CompileError(
          `${file}: スプレッドの後に記述した key は変換できません。key をスプレッドより前に記述してください。`,
        );
      }
      if (statement.source.value !== "rinka/jsx-runtime") continue;
      if (imported === "jsx" || imported === "jsxs") calls.add(specifier.local.name);
      if (imported === "Fragment") fragments.add(specifier.local.name);
    }
  }
  return { calls, fragments };
}

/** `node` が `rinka/jsx-runtime` の `jsx` か `jsxs` の呼び出しかどうかを返す。 */
function isJsxCall(node: Node, runtime: Runtime): node is ESTree.CallExpression {
  return (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    runtime.calls.has(node.callee.name)
  );
}

/** JSX の呼び出し `call` の props に、リアクティブ化か getter 化の規則を適用する。 */
function applyRules(
  call: ESTree.CallExpression,
  runtime: Runtime,
  output: MagicString,
  code: string,
): void {
  const [type, props] = call.arguments;
  if (!type || props?.type !== "ObjectExpression") return;
  const native =
    (type.type === "Literal" && typeof type.value === "string") ||
    (type.type === "Identifier" && runtime.fragments.has(type.name));
  for (const property of props.properties) {
    if (property.type !== "Property" || property.computed || property.kind !== "init") continue;
    const name = propertyName(property.key);
    if (name === undefined) continue;
    const { value } = property;
    if (native) {
      if (name === "children" && value.type === "ArrayExpression") {
        for (const item of value.elements) {
          if (item && item.type !== "SpreadElement" && isReactive(item, runtime))
            wrap(item, output);
        }
      } else if (
        name !== "ref" &&
        name !== "key" &&
        !isEventProp(name) &&
        isReactive(value, runtime)
      ) {
        wrap(value, output);
      }
      continue;
    }
    if (name === "ref" || name === "key" || name.startsWith("load:")) continue;
    if (isLiteral(value) || isFunction(value) || hasAwait(value)) continue;
    const key = code.slice(property.key.start, property.key.end);
    if (property.shorthand) output.prependRight(value.start, `get ${key}() { return (`);
    else output.overwrite(property.start, value.start, `get ${key}() { return (`);
    output.appendLeft(value.end, "); }");
  }
}

/** プロパティのキーが表す名前を返す。 */
function propertyName(key: ESTree.PropertyKey): string | undefined {
  if (key.type === "Identifier") return key.name;
  return key.type === "Literal" && typeof key.value === "string" ? key.value : undefined;
}

/** `expression` を `() => (expression)` にする。 */
function wrap(expression: Node, output: MagicString): void {
  output.prependRight(expression.start, "() => (");
  output.appendLeft(expression.end, ")");
}

/** 値がリテラルかどうかを返す。 */
function isLiteral(node: Node): boolean {
  return (
    node.type === "Literal" || (node.type === "TemplateLiteral" && node.expressions.length === 0)
  );
}

/**
 * 式を関数で包むかどうかを返す。関数呼び出し、プロパティ参照、タグ付きテンプレートを含む式を包む。
 * 内側の関数と JSX の呼び出しの中は判定に含めない。値の中に `await` か `yield` があれば包まない。
 */
function isReactive(expression: Node, runtime: Runtime): boolean {
  if (hasAwait(expression)) return false;
  const search = (node: Node): boolean => {
    if (isFunction(node)) return false;
    if (node.type === "CallExpression") return !isJsxCall(node, runtime);
    if (node.type === "MemberExpression" || node.type === "TaggedTemplateExpression") return true;
    return children(node).some(search);
  };
  return search(expression);
}

/** 内側の関数を除いて、式の中に `await` か `yield` があるかどうかを返す。 */
function hasAwait(node: Node): boolean {
  if (isFunction(node)) return false;
  if (node.type === "AwaitExpression" || node.type === "YieldExpression") return true;
  return children(node).some(hasAwait);
}
