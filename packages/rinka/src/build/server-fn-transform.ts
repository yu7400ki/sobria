import type { MagicString } from "magic-string";
import type { ESTree } from "vite";

import {
  defaultServerFnMethod,
  isServerFnMethod,
  serverFnId,
  serverFnMethods,
  type ServerFnMethod,
} from "../shared/server-fn.ts";
import {
  forEachReference,
  importedNames,
  surround,
  topLevelVariables,
  withoutTypes,
  type Node,
} from "./ast.ts";
import { entries, importInternalAs } from "./entries.ts";
import { CompileError } from "./errors.ts";

/** サーバー関数を ID で登録する関数を、変換したコードの中で呼ぶ名前である。 */
const REGISTER = "__rinka_registerServerFn";
/** サーバー向けのモジュールで、`rinka/internal` の `serverFnModule` を import する名前である。 */
const SERVER_FN_MODULE = "__rinka_serverFnModule";
/** RPC の関数を作成する関数を、変換したコードの中で呼ぶ名前である。 */
const SERVER_FN = "__rinka_serverFn";

/** トップレベルの const の、サーバー関数の定義かミドルウェアの定義を表す。 */
export type Definition =
  | {
      readonly kind: "serverFn";
      readonly name: string;
      /** `<ファイル>#<名前>` の形式の ID である。 */
      readonly id: string;
      readonly init: ESTree.Expression;
      readonly method: ServerFnMethod;
    }
  | { readonly kind: "middleware"; readonly name: string; readonly init: ESTree.Expression };

/** 定義 `definitions` のうち、サーバー関数の ID を返す。 */
export const serverFnIds = (definitions: readonly Definition[]): string[] =>
  definitions.flatMap((definition) => (definition.kind === "serverFn" ? [definition.id] : []));

/**
 * `rinka/server` から import した `defineServerFn` と `defineMiddleware` で初期化したトップレベルの const を、ソースの順に返す。
 * `defineServerFn` をそれ以外の位置で使用するか、サーバー関数のメソッドを静的に読み取れないか、`rinka/server` を名前を指定せずに import すると、ビルドのエラーにする。
 */
export function findDefinitions(
  program: ESTree.Program,
  file: string,
  fnModule: string,
): Definition[] {
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

/**
 * サーバー関数の定義の式を、ID で登録する呼び出しで包む。登録する関数は、モジュールを評価するたびに、
 * ID のモジュールの部分が `fnModule` のサーバー関数の前の登録を削除してから取得する。
 */
export function registerServerFns(
  output: MagicString,
  definitions: readonly Definition[],
  fnModule: string,
): void {
  let registered = false;
  for (const definition of definitions) {
    if (definition.kind !== "serverFn") continue;
    registered = true;
    surround(output, definition.init, `${REGISTER}(${JSON.stringify(definition.id)}, `, ")");
  }
  if (registered) {
    output.prepend(`const ${REGISTER} = ${SERVER_FN_MODULE}(${JSON.stringify(fnModule)});\n`);
    output.prepend(importInternalAs("server", "serverFnModule", SERVER_FN_MODULE));
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
export function replaceDefinitions(
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
    output.prepend(importInternalAs("client", "serverFn", SERVER_FN));
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
