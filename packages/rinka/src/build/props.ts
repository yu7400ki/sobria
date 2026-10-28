import type { ESTree } from "vite";

import type { ElementOptions, PropKind } from "../shared/element.ts";
import { checkPropNames } from "../shared/prop-names.ts";
import { CompileError } from "./errors.ts";
import type { ParamType } from "./type-checker.ts";

/** props の名前ごとの分類 `kinds` と、要素がフォームの部品かどうか `form` から、要素を登録するときの設定を返す。 */
export function optionsOf(kinds: ReadonlyMap<string, PropKind>, form: boolean): ElementOptions {
  const props = Object.fromEntries(kinds);
  return form ? { props, form: true } : { props };
}

/** `code` の中の位置 `position` にある、要素の関数の第 1 引数の型を解析する関数を表す。 */
export type ParamTypeOf = (code: string, position: number) => ParamType | undefined;

/**
 * ファイルのコード `code` にある要素の関数 `fn` の第 1 引数の型を、`paramType` で解析する。props の名前ごとの分類を、宣言した順で返す。
 * 型を解決できないときと、型がオブジェクトの型でないときと、型がインデックスシグネチャを持つときは、ビルドのエラーにする。
 */
export function paramKinds(
  fn: ESTree.Function,
  code: string,
  file: string,
  paramType: ParamTypeOf,
): ReadonlyMap<string, PropKind> {
  const start = propsParamStart(fn, file);
  if (start === undefined) return new Map();
  const type = paramType(code, start);
  if (type === undefined) throw unresolvedProps(file);
  if (type.indexed) {
    throw new CompileError(
      `${file}: Props の型には、インデックスシグネチャを使用できません。props の名前を列挙してください。`,
    );
  }
  const kinds = new Map(type.props.map(({ name, kind }) => [name, kind]));
  const errors = checkPropNames([...kinds.keys()]);
  if (errors.length > 0) throw new CompileError(`${file}: ${errors.join("\n")}`);
  return kinds;
}

/** 要素のファイル `file` の Props の型を解決できないか、Props の型がオブジェクトの型でないときの、ビルドのエラーを返す。 */
export const unresolvedProps = (file: string): CompileError =>
  new CompileError(
    `${file}: Props の型を解決できないか、Props の型がオブジェクトの型ではありません。型の名前と、型を import するパスを確認してください。Props の型には、props の名前と型を列挙したオブジェクトの型を記述してください。ユニオン型、any、unknown は使用できません。`,
  );

/**
 * 要素のファイル `file` の要素の関数 `fn` の、第 1 引数の開始位置を返す。第 1 引数が無ければ `undefined` を返す。
 * 第 1 引数を 1 つの名前で受け取っていないときと、型注釈が無いときは、ビルドのエラーにする。
 */
export function propsParamStart(fn: ESTree.Function, file: string): number | undefined {
  const [param] = fn.params;
  if (!param) return undefined;
  if (param.type !== "Identifier") {
    throw new CompileError(
      `${file}: 要素の関数の第 1 引数は、props のような 1 つの名前で受け取ってください。分割代入、デフォルト値、残余引数は使用できません。`,
    );
  }
  if (!param.typeAnnotation) {
    throw new CompileError(
      `${file}: 要素の関数の第 1 引数に、Props の型注釈を記述してください。props を受け取る要素は、TypeScript のファイル（.tsx）に記述してください。`,
    );
  }
  return param.start;
}

/** 要素の関数の第 2 引数の ctx を、デフォルト値を外して表す。 */
export type CtxParam = Extract<ESTree.ParamPattern, { type: "Identifier" | "ObjectPattern" }>;
