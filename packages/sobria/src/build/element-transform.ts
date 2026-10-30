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
  keyName,
  moduleExportName,
  topLevelVariables,
  unwrap,
  withoutTypes,
  type Node,
} from "./ast.ts";
import { importInternalAs } from "./entries.ts";
import { CompileError } from "./errors.ts";
import { usesForm } from "./form-usage.ts";
import { checkedProps, optionsOf, type CtxParam, type ParamTypeOf } from "./props.ts";

/** 変換する要素のファイルの、タグ名と、ブラウザが読み込むモジュールの URL と、モジュールが静的に import するチャンクの URL を表す。 */
export interface ElementTarget {
  readonly tag: string;
  readonly module: string;
  readonly chunks?: readonly string[];
  /** 要素の関数の第 1 引数の型を解析する関数である。 */
  readonly paramType: ParamTypeOf;
}

/** 要素を登録する関数を、変換したコードの中で呼ぶ名前である。 */
const DEFINE = "__sobria_defineElement";

/**
 * default export した要素の関数を、タグ名と Props の解析の結果を渡して要素を登録する呼び出しにする。
 * クライアント向けなら、登録に `import.meta.hot` を渡し、モジュール自身の更新を受け入れる。
 * サーバー向けなら、登録にモジュールの URL と、`export const load` の値のデフォルトの起動タイミングを渡す。
 */
export function registerElement(
  program: ESTree.Program,
  output: MagicString,
  { tag, module, chunks, paramType }: ElementTarget,
  file: string,
  client: boolean,
): ElementInfo {
  const { exported, fn, id, props, ctx } = elementFunction(program, file);
  const kinds =
    props === undefined ? [] : checkedProps(file, paramType(output.original, id.start)).props;
  const elementOptions = optionsOf(kinds, usesForm(fn, ctx, file));
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
export default ${DEFINE}(${[JSON.stringify(tag), id.name, JSON.stringify(elementOptions), last].join(", ")});
${accept}`);
  output.prepend(importInternalAs(client ? "client" : "server", "defineElement", DEFINE));
  return { tag, options: elementOptions };
}

/** 要素のファイルの default export の文と、default export した関数宣言と、その関数の名前と、第 2 引数を表す。 */
export interface ElementFunction {
  readonly exported: ESTree.ExportDefaultDeclaration;
  readonly fn: ESTree.Function;
  readonly id: ESTree.BindingIdentifier;
  /** 第 1 引数の名前である。第 1 引数が無ければ `undefined` である。 */
  readonly props: ESTree.BindingIdentifier | undefined;
  readonly ctx: CtxParam | undefined;
}

/**
 * 要素のファイル `program` が default export した要素の関数を返す。
 * 要素の関数は、名前付きの関数宣言で default export する。第 1 引数は、型注釈を付けた 1 つの名前で受け取り、第 2 引数は、名前か分割代入で受け取る。引数はどちらも省略できる。この形でなければ、ビルドのエラーにする。
 */
export function elementFunction(program: ESTree.Program, file: string): ElementFunction {
  const exported = program.body.find((statement) => statement.type === "ExportDefaultDeclaration");
  const fn = exported?.declaration;
  if (!exported || fn?.type !== "FunctionDeclaration" || !fn.id) {
    throw new CompileError(
      `${file}: 要素のファイルは、export default function 名前(props, ctx) の形で関数を default export してください。`,
    );
  }
  const [props] = fn.params;
  if (props?.type === "Identifier" && props.name === "this") {
    throw new CompileError(
      `${file}: 要素の関数には、this の引数を宣言できません。this の引数を削除し、第 1 引数で props を、第 2 引数で ctx を受け取ってください。`,
    );
  }
  if (props !== undefined && props.type !== "Identifier") {
    throw new CompileError(
      `${file}: 要素の関数の第 1 引数は、props のような 1 つの名前で受け取ってください。分割代入、デフォルト値、残余引数は使用できません。`,
    );
  }
  if (props !== undefined && !props.typeAnnotation) {
    throw new CompileError(
      `${file}: 要素の関数の第 1 引数に、Props の型注釈を記述してください。props を受け取る要素は、TypeScript のファイル（.tsx）に記述してください。`,
    );
  }
  const declared = fn.params[1];
  const ctx = declared?.type === "AssignmentPattern" ? declared.left : declared;
  if (ctx !== undefined && ctx.type !== "ObjectPattern" && ctx.type !== "Identifier") {
    throw new CompileError(
      `${file}: 要素の関数の 2 番目の引数は、ctx のような名前か、{ form } のような分割代入で受け取ってください。`,
    );
  }
  return { exported, fn, id: fn.id, props, ctx };
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
    const name = keyName(node.computed ? unwrap(node.property) : node.property, node.computed);
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
