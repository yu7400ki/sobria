import type { MagicString } from "magic-string";
import type { ESTree } from "vite";

import {
  propKinds,
  type DefaultLoad,
  type Delivery,
  type ElementInfo,
  type ElementOptions,
} from "../shared/element.ts";
import { defaultLoads } from "../shared/names.ts";
import {
  binds,
  children,
  isFunction,
  moduleExportName,
  topLevelVariables,
  unwrap,
  withoutTypes,
  type Node,
} from "./ast.ts";
import { importInternalAs } from "./entries.ts";
import { CompileError } from "./errors.ts";
import { usesForm } from "./form-usage.ts";
import { analyzeProps } from "./props.ts";

/** 変換する要素のファイルの、タグ名と、ブラウザが読み込むモジュールの URL と、モジュールが静的に import するチャンクの URL を表す。 */
export interface ElementTarget {
  readonly tag: string;
  readonly module: string;
  readonly chunks?: readonly string[];
}

/** 要素を登録する関数を、変換したコードの中で呼ぶ名前である。 */
const DEFINE = "__rinka_defineElement";

/**
 * default export した要素の関数を、タグ名と Props の解析の結果を渡して要素を登録する呼び出しにする。
 * クライアント向けなら、登録に `import.meta.hot` を渡し、モジュール自身の更新を受け入れる。
 * サーバー向けなら、登録にモジュールの URL と、`export const load` の値のデフォルトの起動タイミングを渡す。
 */
export function registerElement(
  program: ESTree.Program,
  output: MagicString,
  { tag, module, chunks }: ElementTarget,
  file: string,
  client: boolean,
): ElementInfo {
  const exported = program.body.find((statement) => statement.type === "ExportDefaultDeclaration");
  const fn = exported?.declaration;
  if (!exported || fn?.type !== "FunctionDeclaration" || !fn.id) {
    throw new CompileError(
      `${file}: 要素のファイルは、export default function 名前(props, ctx) の形で関数を default export してください。`,
    );
  }
  const analyzed = analyzeProps(program, fn, file);
  const elementOptions: ElementOptions = usesForm(fn, file)
    ? { ...analyzed, form: true }
    : analyzed;
  convertSlots(fn, elementOptions, output, file);
  output.remove(exported.start, fn.start);
  const [last, accept] = client
    ? ["import.meta.hot", "if (import.meta.hot) import.meta.hot.accept();\n"]
    : [
        JSON.stringify({
          module,
          load: defaultLoad(program, file),
          ...(chunks && { chunks }),
        } satisfies Delivery),
        "",
      ];
  output.append(`
export default ${DEFINE}(${[JSON.stringify(tag), fn.id.name, JSON.stringify(elementOptions), last].join(", ")});
${accept}`);
  output.prepend(importInternalAs(client ? "client" : "server", "defineElement", DEFINE));
  return { tag, options: elementOptions };
}

/** 要素のファイルの最上位の `export const load` の値を返す。記述が無ければ `load` を返す。ほかの形で `load` を export すると、ビルドのエラーにする。 */
function defaultLoad(program: ESTree.Program, file: string): DefaultLoad {
  const form = () =>
    new CompileError(
      `${file}: load は、export const load = "visible" の形で export してください。`,
    );
  for (const statement of program.body) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    if (statement.specifiers.some((specifier) => moduleExportName(specifier.exported) === "load")) {
      throw form();
    }
  }
  for (const { declaration, exported } of topLevelVariables(program)) {
    if (!exported) continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== "Identifier") {
        if (binds(declarator.id, "load")) throw form();
        continue;
      }
      if (declarator.id.name !== "load") continue;
      if (declaration.kind !== "const") throw form();
      const init = declarator.init && withoutTypes(declarator.init);
      if (init?.type === "Literal" && isDefaultLoad(init.value)) return init.value;
      throw new CompileError(
        `${file}: export const load には、${defaultLoads.map((value) => `"${value}"`).join("、")} のどれかの文字列を記述してください。メディアクエリは、要素を配置するページで load:media に指定してください。`,
      );
    }
  }
  return "load";
}

/** `value` が、`export const load` に記述できる起動タイミングかどうかを返す。 */
const isDefaultLoad = (value: unknown): value is DefaultLoad =>
  defaultLoads.some((load) => load === value);

/**
 * 要素の関数の JSX の子に置いた `{props.children}`、`{props.X}`、`{props.X ?? デフォルトの中身}` を `<slot>` にする。
 * 要素の関数の中の関数にスロットを置くか、同じスロットを 2 回置くか、それ以外の位置で `props` のメンバーか分割代入でスロットを参照すると、ビルドのエラーにする。
 * props と同じ名前の引数を持つ関数の中は変換しない。
 */
function convertSlots(
  fn: ESTree.Function,
  elementOptions: ElementOptions,
  output: MagicString,
  file: string,
): void {
  const [param] = fn.params;
  if (param?.type !== "Identifier" || !fn.body) return;
  const names = propKinds(elementOptions).slots;
  const misplaced = (name: string) =>
    new CompileError(
      `${file}: スロット ${name} は、要素の関数が返す JSX の子に、{${param.name}.${name}} か {${param.name}.${name} ?? デフォルトの中身} の形で置いてください。それ以外の位置ではスロットの内容を参照できません。`,
    );
  const isParam = (node: Node): boolean => {
    const expression = unwrap(node);
    return expression.type === "Identifier" && expression.name === param.name;
  };
  /** `props` のメンバーの参照か、`props` を初期値にした分割代入が取り出すスロットの名前を返す。 */
  const referencedSlot = (node: Node): string | undefined => {
    if (node.type === "VariableDeclarator" && node.init && isParam(node.init)) {
      return node.id.type === "ObjectPattern" ? patternSlot(node.id, names) : undefined;
    }
    if (node.type !== "MemberExpression" || !isParam(node.object)) return undefined;
    const key = node.computed ? unwrap(node.property) : node.property;
    const name =
      key.type === "Identifier" && !node.computed
        ? key.name
        : key.type === "Literal" && typeof key.value === "string"
          ? key.value
          : undefined;
    return name !== undefined && names.has(name) ? name : undefined;
  };
  const placed = new Set<string>();
  /** JSX の子の式の位置のスロット `slot` を、`<slot>` に変換する。 */
  const place = (
    container: ESTree.JSXExpressionContainer,
    slot: NonNullable<ReturnType<typeof slotOf>>,
    nested: boolean,
  ): void => {
    if (nested) {
      throw new CompileError(
        `${file}: スロット ${slot.name} は、要素の関数の中の関数に置けません。要素の関数が返す JSX に直接置いてください。`,
      );
    }
    if (placed.has(slot.name)) {
      throw new CompileError(
        `${file}: スロット ${slot.name} を 2 回置いています。スロットは 1 回だけ置いてください。`,
      );
    }
    placed.add(slot.name);
    const name = slot.name === "children" ? "" : ` name=${JSON.stringify(slot.name)}`;
    const { fallback } = slot;
    if (!fallback) {
      output.overwrite(container.start, container.end, `<slot${name} />`);
      return;
    }
    const jsx = fallback.type === "JSXElement" || fallback.type === "JSXFragment";
    output.overwrite(container.start, fallback.start, `<slot${name}>${jsx ? "" : "{"}`);
    output.overwrite(fallback.end, container.end, `${jsx ? "" : "}"}</slot>`);
  };
  const visit = (node: Node, nested: boolean): void => {
    if (isFunction(node)) {
      const rebinds = node.params.some(
        (other) => other.type === "Identifier" && other.name === param.name,
      );
      if (!rebinds) for (const child of children(node)) visit(child, true);
      return;
    }
    const referenced = referencedSlot(node);
    if (referenced !== undefined) throw misplaced(referenced);
    const containers =
      node.type === "JSXElement" || node.type === "JSXFragment"
        ? new Set<Node>(node.children)
        : undefined;
    for (const child of children(node)) {
      if (
        containers?.has(child) &&
        child.type === "JSXExpressionContainer" &&
        child.expression.type !== "JSXEmptyExpression"
      ) {
        const slot = slotOf(child.expression, param.name, names);
        if (slot) {
          place(child, slot, nested);
          if (slot.fallback) visit(slot.fallback, nested);
          continue;
        }
      }
      visit(child, nested);
    }
  };
  visit(fn.body, false);
}

/** 分割代入のパターンが取り出すスロットの名前を返す。スロットを取り出さなければ undefined を返す。 */
function patternSlot(
  pattern: ESTree.ObjectPattern,
  names: ReadonlySet<string>,
): string | undefined {
  for (const property of pattern.properties) {
    if (property.type !== "Property" || property.computed) continue;
    const { key } = property;
    const name =
      key.type === "Identifier" ? key.name : key.type === "Literal" ? String(key.value) : undefined;
    if (name !== undefined && names.has(name)) return name;
  }
  return undefined;
}

/** 式が `props` のスロットの参照なら、スロットの名前とデフォルトの中身を返す。式を囲む括弧は外して判定する。 */
function slotOf(
  node: Node,
  props: string,
  names: ReadonlySet<string>,
): { name: string; fallback?: ESTree.Expression } | undefined {
  const expression = unwrap(node);
  if (expression.type === "LogicalExpression" && expression.operator === "??") {
    const slot = slotOf(expression.left, props, names);
    return slot && !slot.fallback ? { ...slot, fallback: expression.right } : undefined;
  }
  if (expression.type !== "MemberExpression" || expression.computed) return undefined;
  const { object, property } = expression;
  if (object.type !== "Identifier" || object.name !== props || property.type !== "Identifier") {
    return undefined;
  }
  return names.has(property.name) ? { name: property.name } : undefined;
}
