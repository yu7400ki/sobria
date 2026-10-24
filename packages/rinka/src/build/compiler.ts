import { MagicString } from "magic-string";

import type { ElementInfo } from "../shared/element.ts";
import { serverFnId } from "../shared/server-fn.ts";
import { parseModule, type ModuleSource, type Node, type Transformed } from "./ast.ts";
import { registerElement, type ElementTarget } from "./element-transform.ts";
import { importInternalAs } from "./entries.ts";
import { STOP_IF_SEEDING, stopAwaits } from "./seeding.ts";
import {
  findDefinitions,
  registerServerFns,
  replaceDefinitions,
  serverFnNames,
} from "./server-fn-transform.ts";
import { rewriteSheetImports } from "./sheets.ts";
import { addElementSites, addMemoSites } from "./sites.ts";

export { CompileError } from "./errors.ts";

/** 元のソースに適用する変換の設定を表す。 */
export interface SourceOptions extends ModuleSource {
  /** クライアント向けのコードなら真である。 */
  readonly client: boolean;
  /** 要素のファイルなら、要素のタグ名と、ブラウザが読み込むモジュールの URL と、そのモジュールが静的に import するチャンクの URL を持つ。 */
  readonly element?: ElementTarget;
  /** サーバー関数の ID のモジュールの部分である。省略すると `file` を使用する。 */
  readonly fnModule?: string;
}

/** 元のソースを変換した結果を表す。 */
export interface SourceResult extends Transformed {
  /** 要素のファイルなら、要素の情報を持つ。 */
  readonly element: ElementInfo | undefined;
  /** ファイルで定義したサーバー関数の ID を、ソースの順に列挙する。 */
  readonly serverFns: readonly string[];
}

/**
 * 元のソースに、`rinka` の `memo` とコンポーネントの JSX の呼び出し箇所の ID を付与し、`with { type: 'css' }` の import をシートのモジュールの import にする。
 * クライアント向けのコードでは、シード中に開始した async 関数を、最初の `await` で停止させる。
 * 要素のファイルでは、default export した関数を、要素を登録する呼び出しに書き換え、関数の中の JSX のスロットを `<slot>` にする。
 * `rinka/server` の `defineServerFn` で初期化したトップレベルの const は、サーバー向けでは ID で登録し、クライアント向けでは RPC の関数を作成する呼び出しに置換する。
 * クライアント向けでは、`defineMiddleware` で初期化したトップレベルの const の初期化の式を `undefined` に置換し、置換で使用されなくなった import を除去する。
 */
export function transformSource(code: string, options: SourceOptions): SourceResult {
  const program = parseModule(code, options);
  const output = new MagicString(code);
  const fnModule = options.fnModule ?? options.file;
  const definitions = findDefinitions(program, options.file);
  const replaced = new Set<Node>(
    options.client ? definitions.map((definition) => definition.init) : [],
  );
  addMemoSites(program, output, code, options.file, replaced);
  addElementSites(program, output, code, options.file, replaced);
  rewriteSheetImports(program, output, code, options.file);
  const element =
    options.element &&
    registerElement(program, output, options.element, options.file, options.client);
  if (options.client) {
    if (stopAwaits(program, output, replaced)) {
      output.prepend(importInternalAs("client", "stopIfSeeding", STOP_IF_SEEDING));
    }
    replaceDefinitions(program, output, code, definitions, fnModule);
  } else {
    registerServerFns(output, definitions, fnModule);
  }
  return {
    code: output.toString(),
    map: output.generateMap({ hires: true, source: options.id, includeContent: true }),
    element,
    serverFns: serverFnNames(definitions).map((name) => serverFnId(fnModule, name)),
  };
}
