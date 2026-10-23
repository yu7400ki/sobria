import { MagicString, type SourceMap } from "magic-string";
import type { ESTree } from "vite";

import type { DefaultLoad, Delivery, ElementInfo, ElementOptions } from "../shared/element.ts";
import { defaultLoads } from "../shared/names.ts";
import {
  defaultServerFnMethod,
  isServerFnMethod,
  serverFnId,
  serverFnMethods,
  type ServerFnMethod,
} from "../shared/server-fn.ts";
import {
  binds,
  children,
  isFunction,
  lineColumn,
  lineStarts,
  follow,
  forEachReference,
  moduleExportName,
  topLevelVariables,
  withoutTypes,
  importedNames,
  insertInside,
  parseModule,
  unwrap,
  surround,
  walk,
  type FunctionNode,
  type ModuleSource,
  type Node,
} from "./ast.ts";
import { entries } from "./entries.ts";
import { CompileError } from "./errors.ts";
import { usesForm } from "./form-usage.ts";
import { analyzeProps } from "./props.ts";
import { rewriteSheetImports } from "./sheets.ts";

export { CompileError } from "./errors.ts";

/** 元のソースに適用する変換の設定を表す。 */
export interface SourceOptions extends ModuleSource {
  /** クライアント向けのコードなら真である。 */
  readonly client: boolean;
  /** 要素のファイルなら、要素のタグ名と、ブラウザが読み込むモジュールの URL を持つ。 */
  readonly element?: { readonly tag: string; readonly module: string };
  /** サーバー関数の ID のモジュールの部分である。省略すると `file` を使用する。 */
  readonly fnModule?: string;
}

/** 変換したコードと、元のコードへのソースマップを表す。 */
export interface Transformed {
  readonly code: string;
  readonly map: SourceMap;
}

/** 元のソースを変換した結果を表す。 */
export interface SourceResult extends Transformed {
  /** 要素のファイルなら、要素の情報を持つ。 */
  readonly element: ElementInfo | undefined;
  /** ファイルで定義したサーバー関数の ID を、ソースの順に列挙する。 */
  readonly serverFns: readonly string[];
}

/** 変換したコードで `stopIfSeeding` を呼ぶときの名前である。 */
const STOP_IF_SEEDING = "__rinka_stopIfSeeding";
/** async 関数が開始した時点で受け取った `stopIfSeeding` の戻り値を保持する変数の名前である。 */
const STOP = "__rinka_stop";
/** 要素を登録する関数を、変換したコードの中で呼ぶ名前である。 */
const DEFINE = "__rinka_defineElement";
/** サーバー関数を ID で登録する関数を、変換したコードの中で呼ぶ名前である。 */
const REGISTER = "__rinka_registerServerFn";
/** RPC の関数を作成する関数を、変換したコードの中で呼ぶ名前である。 */
const SERVER_FN = "__rinka_serverFn";

/**
 * 元のソースに、`rinka` の `memo` の呼び出し箇所の ID を付与し、`with { type: 'css' }` の import をシートのモジュールの import にする。
 * クライアント向けのコードでは、シード中に開始した async 関数を、最初の `await` で停止させる。
 * 要素のファイルでは、default export した関数を、要素を登録する呼び出しに書き換え、関数の中の JSX のスロットを `<slot>` にする。
 * `rinka/server` の `defineServerFn` で初期化したトップレベルの const は、サーバー向けでは ID で登録し、クライアント向けでは RPC の関数を作成する呼び出しに置換する。
 * クライアント向けでは、`defineMiddleware` で初期化したトップレベルの const の初期化の式を `undefined` に置換し、置換で使用されなくなった import を除去する。
 */
export function transformSource(code: string, options: SourceOptions): SourceResult {
  const program = parseModule(code, options);
  const output = new MagicString(code);
  const definitions = findDefinitions(program, options.file, options.fnModule ?? options.file);
  const replaced = new Set<Node>(
    options.client ? definitions.map((definition) => definition.init) : [],
  );
  addMemoSites(program, output, code, options.file, replaced);
  rewriteSheetImports(program, output, code, options.file);
  const element =
    options.element &&
    registerElement(program, output, options.element, options.file, options.client);
  if (options.client) {
    if (stopAwaits(program, output, replaced)) {
      output.prepend(
        `import { stopIfSeeding as ${STOP_IF_SEEDING} } from "${entries.internal}";\n`,
      );
    }
    replaceDefinitions(program, output, code, definitions);
  } else {
    registerServerFns(output, definitions);
  }
  return {
    code: output.toString(),
    map: output.generateMap({ hires: true, source: options.id, includeContent: true }),
    element,
    serverFns: definitions.flatMap((definition) =>
      definition.kind === "serverFn" ? [definition.id] : [],
    ),
  };
}

/**
 * default export した要素の関数を、タグ名と Props の解析の結果を渡して要素を登録する呼び出しにする。
 * クライアント向けなら、登録に `import.meta.hot` を渡し、モジュール自身の更新を受け入れる。
 * サーバー向けなら、登録にモジュールの URL と、`export const load` の値のデフォルトの起動タイミングを渡す。
 */
function registerElement(
  program: ESTree.Program,
  output: MagicString,
  { tag, module }: { readonly tag: string; readonly module: string },
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
    : [JSON.stringify({ module, load: defaultLoad(program, file) } satisfies Delivery), ""];
  output.append(`
export default ${DEFINE}(${[JSON.stringify(tag), fn.id.name, JSON.stringify(elementOptions), last].join(", ")});
${accept}`);
  output.prepend(`import { defineElement as ${DEFINE} } from "${entries.internal}";
`);
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

/** `rinka` から import した `memo` の呼び出しに、`{ site: "ファイル:行:列" }` を付与する。 */
function addMemoSites(
  program: ESTree.Program,
  output: MagicString,
  code: string,
  file: string,
  replaced: ReadonlySet<Node>,
): void {
  const names = importedNames(program, entries.main).get("memo");
  if (!names) return;
  const starts = lineStarts(code);
  walk(
    program,
    (node) => {
      if (node.type !== "CallExpression") return;
      if (node.callee.type !== "Identifier" || !names.has(node.callee.name)) return;
      const [fn, options] = node.arguments;
      if (!fn || fn.type === "SpreadElement" || options?.type === "SpreadElement") return;
      const site = `site: ${JSON.stringify(`${file}:${lineColumn(starts, node.start)}`)}`;
      if (!options) {
        follow(output, fn, `, { ${site} }`);
      } else if (options.type === "ObjectExpression") {
        insertInside(output, options, options.properties.length > 0 ? ` ${site},` : ` ${site} `);
      } else {
        surround(output, options, "{ ...", `, ${site} }`);
      }
    },
    (node) => replaced.has(node),
  );
}

/**
 * async 関数（generator を除く）の本体にある `await` が待つ値を、その関数が開始した時点で受け取った `stopIfSeeding` の戻り値に渡す。
 * 内側の関数の `await` は、内側の関数の戻り値に渡す。1 つでも書き換えたら真を返す。
 * `for await` の文は、反復する値をその戻り値の `iterate` に渡す。
 */
function stopAwaits(
  program: ESTree.Program,
  output: MagicString,
  replaced: ReadonlySet<Node>,
): boolean {
  let stopped = false;
  const visit = (node: Node, owner: { used: boolean } | null): void => {
    if (replaced.has(node)) return;
    if (isFunction(node)) {
      const own = node.async && !node.generator ? { used: false } : null;
      for (const child of children(node)) visit(child, own);
      if (own?.used) {
        insertStop(node, output);
        stopped = true;
      }
      return;
    }
    for (const child of children(node)) visit(child, owner);
    if (!owner) return;
    if (node.type === "AwaitExpression") {
      owner.used = true;
      surround(output, node.argument, `${STOP}(`, ")");
    } else if (node.type === "ForOfStatement" && node.await) {
      owner.used = true;
      surround(output, node.right, `${STOP}.iterate(`, ")");
    }
  };
  visit(program, null);
  return stopped;
}

/** 関数の本体の先頭で `stopIfSeeding` を呼び、戻り値を `STOP` の名前の変数に保持する。 */
function insertStop(fn: FunctionNode, output: MagicString): void {
  const { body } = fn;
  if (!body) return;
  const declaration = `const ${STOP} = ${STOP_IF_SEEDING}();`;
  if (body.type === "BlockStatement") {
    insertInside(output, body, ` ${declaration}`);
  } else {
    surround(output, body, `{ ${declaration} return `, "; }");
  }
}

/**
 * 要素の関数の JSX の子に置いた `{props.children}`、`{props.X}`、`{props.X ?? 既定の中身}` を `<slot>` にする。
 * 要素の関数の中の関数にスロットを置くと、ビルドのエラーにする。props と同じ名前の引数を持つ関数の中は変換しない。
 */
function convertSlots(
  fn: ESTree.Function,
  elementOptions: ElementOptions,
  output: MagicString,
  file: string,
): void {
  const [param] = fn.params;
  const names = new Set(["children", ...(elementOptions.slots ?? [])]);
  if (param?.type !== "Identifier" || !fn.body) return;
  const misplaced = (name: string) =>
    new CompileError(
      `${file}: スロット ${name} は、要素の関数が返す JSX の子に、{${param.name}.${name}} か {${param.name}.${name} ?? デフォルトの中身} の形で置いてください。それ以外の位置ではスロットの内容を参照できません。`,
    );
  /** 引数の別名である。 */
  const aliases = new Set<string>();
  const placed = new Set<string>();
  /** `<slot>` に変換した `props` のスロットの参照である。 */
  const converted = new Set<Node>();
  const visit = (node: Node, nested: boolean): void => {
    if (isFunction(node)) {
      const rebinds = node.params.some(
        (other) => other.type === "Identifier" && other.name === param.name,
      );
      if (!rebinds) for (const child of children(node)) visit(child, true);
      return;
    }
    if (node.type === "JSXElement" || node.type === "JSXFragment") placeSlots(node, nested);
    for (const child of children(node)) visit(child, nested);
  };
  const placeSlots = (node: ESTree.JSXElement | ESTree.JSXFragment, nested: boolean): void => {
    for (const child of node.children) {
      if (
        child.type !== "JSXExpressionContainer" ||
        child.expression.type === "JSXEmptyExpression"
      ) {
        continue;
      }
      const slot = slotOf(child.expression, param.name, names);
      if (!slot) continue;
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
      converted.add(slot.member);
      const name = slot.name === "children" ? "" : ` name=${JSON.stringify(slot.name)}`;
      const { fallback } = slot;
      if (!fallback) {
        output.overwrite(child.start, child.end, `<slot${name} />`);
        continue;
      }
      const jsx = fallback.type === "JSXElement" || fallback.type === "JSXFragment";
      output.overwrite(child.start, fallback.start, `<slot${name}>${jsx ? "" : "{"}`);
      output.overwrite(fallback.end, child.end, `${jsx ? "" : "}"}</slot>`);
    }
  };
  visit(fn.body, false);
  const isParam = (node: Node): boolean => {
    const expression = unwrap(node);
    return expression.type === "Identifier" && expression.name === param.name;
  };
  const check = (node: Node): void => {
    if (isFunction(node)) {
      const rebinds = node.params.some(
        (other) => other.type === "Identifier" && other.name === param.name,
      );
      if (rebinds) return;
    }
    if (node.type === "VariableDeclarator" && node.init && isParam(node.init)) {
      if (node.id.type === "Identifier") aliases.add(node.id.name);
      const name = node.id.type === "ObjectPattern" ? patternSlot(node.id, names) : undefined;
      if (name !== undefined) throw misplaced(name);
    }
    if (node.type === "MemberExpression" && isParam(node.object) && node.computed) {
      const key = unwrap(node.property);
      if (key.type === "Literal" && typeof key.value === "string" && names.has(key.value)) {
        throw misplaced(key.value);
      }
    }
    if (
      node.type === "MemberExpression" &&
      !node.computed &&
      node.object.type === "Identifier" &&
      aliases.has(node.object.name) &&
      node.property.type === "Identifier" &&
      names.has(node.property.name)
    ) {
      throw misplaced(node.property.name);
    }
    const slot = slotOf(node, param.name, names);
    if (slot && !slot.fallback && !converted.has(slot.member)) throw misplaced(slot.name);
    for (const child of children(node)) check(child);
  };
  check(fn.body);
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

/** 式が `props` のスロットの参照なら、スロットの名前、`props` のメンバーの式、デフォルトの中身を返す。式を囲む括弧は外して判定する。 */
function slotOf(
  node: Node,
  props: string,
  names: ReadonlySet<string>,
): { name: string; member: Node; fallback?: ESTree.Expression } | undefined {
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
  return names.has(property.name) ? { name: property.name, member: expression } : undefined;
}

/** トップレベルの const の、サーバー関数の定義かミドルウェアの定義を表す。 */
type Definition =
  | {
      readonly kind: "serverFn";
      readonly name: string;
      /** `<ファイル>#<名前>` の形式の ID である。 */
      readonly id: string;
      readonly init: ESTree.Expression;
      readonly method: ServerFnMethod;
    }
  | { readonly kind: "middleware"; readonly name: string; readonly init: ESTree.Expression };

/**
 * `rinka/server` から import した `defineServerFn` と `defineMiddleware` で初期化したトップレベルの const を、ソースの順に返す。
 * `defineServerFn` をそれ以外の位置で使用するか、サーバー関数のメソッドを静的に読み取れないか、`rinka/server` を名前を指定せずに import すると、ビルドのエラーにする。
 */
function findDefinitions(program: ESTree.Program, file: string, fnModule: string): Definition[] {
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== entries.server)
      continue;
    if (statement.importKind === "type") continue;
    if (statement.specifiers.some((specifier) => specifier.type !== "ImportSpecifier")) {
      throw new CompileError(
        `${file}: ${entries.server} は、import { defineServerFn } from "${entries.server}" のように、名前を指定して import してください。`,
      );
    }
  }
  const imported = importedNames(program, entries.server);
  const defineNames = imported.get("defineServerFn") ?? new Set<string>();
  const middlewareNames = imported.get("defineMiddleware") ?? new Set<string>();
  if (defineNames.size === 0 && middlewareNames.size === 0) return [];
  const definitions: Definition[] = [];
  const allowed = new Set<Node>();
  for (const { declaration } of topLevelVariables(program)) {
    if (declaration.kind !== "const") continue;
    for (const { id, init } of declaration.declarations) {
      if (id.type !== "Identifier" || init?.type !== "CallExpression") continue;
      const { callee } = init;
      if (callee.type === "Identifier" && middlewareNames.has(callee.name)) {
        allowed.add(callee);
        definitions.push({ kind: "middleware", name: id.name, init });
        continue;
      }
      const first = callee.type === "CallExpression" ? callee : init;
      if (first.callee.type !== "Identifier" || !defineNames.has(first.callee.name)) continue;
      allowed.add(first.callee);
      const options = first === init ? undefined : first.arguments[0];
      definitions.push({
        kind: "serverFn",
        name: id.name,
        id: serverFnId(fnModule, id.name),
        init,
        method: methodOf(options, file, id.name),
      });
    }
  }
  const misplaced = (name: string, form: string) =>
    new CompileError(
      `${file}: ${name} は、const 名前 = ${form} の形で、トップレベルの const の初期化の式で呼んでください。`,
    );
  forEachReference(
    program,
    (node) => node.type === "ImportDeclaration",
    (node) => {
      if (allowed.has(node)) return;
      if (defineNames.has(node.name)) throw misplaced("defineServerFn", "defineServerFn(…)");
    },
  );
  return definitions;
}

/** `defineServerFn` の 1 段目のオプションから、サーバー関数のメソッドを読み取る。1 段目が無いか、`method` が無ければ `defaultServerFnMethod` を返す。 */
function methodOf(
  options: ESTree.Argument | undefined,
  file: string,
  name: string,
): ServerFnMethod {
  const error = () =>
    new CompileError(
      `${file}: サーバー関数 ${name} の method は、defineServerFn の 1 段目のオブジェクトに ${serverFnMethods.map((method) => JSON.stringify(method)).join(" か ")} の文字列で記述してください。`,
    );
  if (options === undefined) return defaultServerFnMethod;
  if (options.type !== "ObjectExpression") throw error();
  let method: ServerFnMethod = defaultServerFnMethod;
  for (const property of options.properties) {
    if (property.type === "SpreadElement" || property.computed) throw error();
    const { key } = property;
    const keyName =
      key.type === "Identifier" ? key.name : key.type === "Literal" ? key.value : undefined;
    if (keyName !== "method") continue;
    const value = withoutTypes(property.value);
    if (value.type !== "Literal" || !isServerFnMethod(value.value)) throw error();
    method = value.value;
  }
  return method;
}

/** サーバー関数の定義の式を、ID で登録する呼び出しで包む。 */
function registerServerFns(output: MagicString, definitions: readonly Definition[]): void {
  let registered = false;
  for (const definition of definitions) {
    if (definition.kind !== "serverFn") continue;
    registered = true;
    surround(output, definition.init, `${REGISTER}(${JSON.stringify(definition.id)}, `, ")");
  }
  if (registered) {
    output.prepend(`import { registerServerFn as ${REGISTER} } from "${entries.internal}";\n`);
  }
}

/** トップレベルの、関数の宣言か、関数で初期化した 1 つの const の宣言を表す。 */
interface Helper {
  readonly statement: ESTree.Statement;
  readonly id: Node;
  readonly name: string;
}

/** `export` を付けていない、トップレベルの関数の宣言と、関数式かアロー関数で初期化した 1 つの const の宣言を返す。 */
function helpersOf(program: ESTree.Program): Helper[] {
  return program.body.flatMap((statement): Helper[] => {
    if (statement.type === "FunctionDeclaration" && statement.id) {
      return [{ statement, id: statement.id, name: statement.id.name }];
    }
    if (statement.type !== "VariableDeclaration" || statement.kind !== "const") return [];
    const [declarator] = statement.declarations;
    if (statement.declarations.length !== 1 || declarator?.id.type !== "Identifier") return [];
    const init = declarator.init && withoutTypes(declarator.init);
    if (init?.type !== "ArrowFunctionExpression" && init?.type !== "FunctionExpression") return [];
    return [{ statement, id: declarator.id, name: declarator.id.name }];
  });
}

/**
 * サーバー関数の定義の式を、RPC の関数を作成する呼び出しに、ミドルウェアの定義の式を `undefined` に置換する。
 * 置換で使用されなくなった、トップレベルの関数と関数で初期化した const を除去し、使用されなくなった import の指定子を除去する。
 * 指定子が残らない import の文は、文ごと除去する。
 */
function replaceDefinitions(
  program: ESTree.Program,
  output: MagicString,
  code: string,
  definitions: readonly Definition[],
): void {
  if (definitions.length === 0) return;
  const helpers = helpersOf(program);
  const declarations = new Set(helpers.map((helper) => helper.id));
  const removed = new Set<Node>(definitions.map((definition) => definition.init));
  const used = (skipped: ReadonlySet<Node>): Set<string> => {
    const names = new Set<string>();
    forEachReference(
      program,
      (node) => node.type === "ImportDeclaration" || declarations.has(node) || skipped.has(node),
      (node) => {
        names.add(node.name);
      },
    );
    return names;
  };
  const before = used(new Set());
  let after = used(removed);
  const isKept = (specifier: ESTree.ImportDeclaration["specifiers"][number]) =>
    after.has(specifier.local.name) || !before.has(specifier.local.name);
  for (let changed = true; changed;) {
    changed = false;
    for (const helper of helpers) {
      if (removed.has(helper.statement) || after.has(helper.name) || !before.has(helper.name)) {
        continue;
      }
      removed.add(helper.statement);
      removeStatement(output, code, helper.statement);
      changed = true;
    }
    if (changed) after = used(removed);
  }
  let serverFns = false;
  for (const definition of definitions) {
    const { init } = definition;
    if (definition.kind === "middleware") {
      output.overwrite(init.start, init.end, "undefined");
      continue;
    }
    serverFns = true;
    output.overwrite(
      init.start,
      init.end,
      `${SERVER_FN}(${JSON.stringify(definition.id)}, ${JSON.stringify(definition.method)})`,
    );
  }
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    if (statement.specifiers.length === 0) continue;
    const kept = statement.specifiers.filter(isKept);
    if (kept.length === statement.specifiers.length) continue;
    const values = kept.filter(
      (specifier) => specifier.type !== "ImportSpecifier" || specifier.importKind !== "type",
    );
    if (values.length === 0) {
      removeStatement(output, code, statement);
      continue;
    }
    const text = (node: { start: number; end: number }) => code.slice(node.start, node.end);
    const named = kept.filter((specifier) => specifier.type === "ImportSpecifier");
    const parts = [
      ...kept.filter((specifier) => specifier.type !== "ImportSpecifier").map(text),
      ...(named.length > 0 ? [`{ ${named.map(text).join(", ")} }`] : []),
    ];
    output.overwrite(statement.start, statement.source.start, `import ${parts.join(", ")} from `);
  }
  if (serverFns) {
    output.prepend(`import { serverFn as ${SERVER_FN} } from "${entries.internal}";\n`);
  }
}

/** 文を、直後の改行とともに除去する。 */
function removeStatement(
  output: MagicString,
  code: string,
  statement: { start: number; end: number },
): void {
  output.remove(statement.start, code[statement.end] === "\n" ? statement.end + 1 : statement.end);
}
