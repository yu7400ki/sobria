import { MagicString } from "magic-string";
import { parseSync, type ESTree } from "vite";

import { isEventProp } from "../shared/names.ts";
import { children, importedNames, isFunction, surround, type Node } from "./ast.ts";
import type { Transformed } from "./compiler.ts";
import { CompileError } from "./errors.ts";

/** `rinka/jsx-runtime` から import した名前を表す。 */
interface Runtime {
  /** `jsx` の、ファイルの中の名前である。 */
  readonly single: ReadonlySet<string>;
  /** 子の配列を受け取る `jsxs` の、ファイルの中の名前である。 */
  readonly multiple: ReadonlySet<string>;
  /** `Fragment` の、ファイルの中の名前である。 */
  readonly fragments: ReadonlySet<string>;
}

/**
 * oxc が JSX を変換した後のコードの、`rinka/jsx-runtime` の呼び出しに規則を適用する。
 * ネイティブのタグと Fragment の属性と子は、関数呼び出し、プロパティ参照、タグ付きテンプレートを含む式を関数で包む。
 * コンポーネントに渡す props と children は、リテラルと関数を除いて getter にする。
 */
export function transformJsx(code: string, file: string): Transformed {
  const { program, errors } = parseSync(file, code, {
    lang: "js",
    sourceType: "module",
    preserveParens: false,
  });
  const [error] = errors;
  if (error) throw new CompileError(`${file} を解析できません: ${error.message}`);
  const output = new MagicString(code);
  if (importedNames(program, "rinka").has("createElement")) {
    throw new CompileError(
      `${file}: スプレッドの後に記述した key は変換できません。key をスプレッドより前に記述してください。`,
    );
  }
  const runtime = runtimeNames(program);
  const visit = (node: Node): void => {
    for (const child of children(node)) visit(child);
    if (isJsxCall(node, runtime)) applyRules(node, runtime, output, code);
  };
  visit(program);
  return {
    code: output.toString(),
    map: output.generateMap({ hires: true, source: file, includeContent: true }),
  };
}

/** `rinka/jsx-runtime` から import した名前を返す。 */
function runtimeNames(program: ESTree.Program): Runtime {
  const names = importedNames(program, "rinka/jsx-runtime");
  const none = new Set<string>();
  return {
    single: names.get("jsx") ?? none,
    multiple: names.get("jsxs") ?? none,
    fragments: names.get("Fragment") ?? none,
  };
}

/** `node` が `rinka/jsx-runtime` の `jsx` か `jsxs` の呼び出しかどうかを返す。 */
function isJsxCall(node: Node, runtime: Runtime): node is ESTree.CallExpression {
  if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return false;
  const { name } = node.callee;
  return runtime.single.has(name) || runtime.multiple.has(name);
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
  const multiple = call.callee.type === "Identifier" && runtime.multiple.has(call.callee.name);
  for (const property of props.properties) {
    if (property.type !== "Property" || property.computed || property.kind !== "init") continue;
    const name = propertyName(property.key);
    if (name === undefined) continue;
    const { value } = property;
    if (native) {
      if (name === "children" && multiple && value.type === "ArrayExpression") {
        for (const item of value.elements) {
          if (item && item.type !== "SpreadElement" && isReactive(item, runtime)) {
            wrap(item, output);
          }
        }
      } else if (name !== "ref" && !isEventProp(name) && isReactive(value, runtime)) {
        wrap(value, output);
      }
      continue;
    }
    if (name === "ref" || name.startsWith("load:")) continue;
    if (isLiteral(value) || isFunction(value) || hasAwait(value) || usesCallee(value)) continue;
    const key = code.slice(property.key.start, property.key.end);
    if (!property.shorthand) output.remove(property.start, value.start);
    surround(output, value, `get ${key}() { return (`, "); }");
  }
}

/** プロパティのキーが表す名前を返す。 */
function propertyName(key: ESTree.PropertyKey): string | undefined {
  if (key.type === "Identifier") return key.name;
  return key.type === "Literal" && typeof key.value === "string" ? key.value : undefined;
}

/** `expression` を `() => (expression)` にする。 */
function wrap(expression: Node, output: MagicString): void {
  surround(output, expression, "() => (", ")");
}

/** 値がリテラルかどうかを返す。負の数はリテラルとして扱う。 */
function isLiteral(node: Node): boolean {
  if (node.type === "UnaryExpression") {
    return node.operator === "-" && node.argument.type === "Literal";
  }
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

/**
 * 内側の通常の関数を除いて、式の中に `this`、`arguments`、`super`、`new.target` があるかどうかを返す。
 * getter の中では、これらが別の値を指す。
 */
function usesCallee(node: Node): boolean {
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") return false;
  if (node.type === "ThisExpression" || node.type === "Super") return true;
  if (node.type === "MetaProperty" && node.meta.name === "new") return true;
  if (node.type === "Identifier" && node.name === "arguments") return true;
  if (node.type === "MemberExpression" && !node.computed) return usesCallee(node.object);
  if (node.type === "Property" && !node.computed) return usesCallee(node.value);
  return children(node).some(usesCallee);
}
