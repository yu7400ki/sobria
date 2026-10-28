import type { ESTree } from "vite";

import type { ElementOptions } from "../shared/element.ts";
import { checkPropNames } from "../shared/prop-names.ts";
import { CompileError } from "./errors.ts";
import type { ParamType, PropType } from "./type-checker.ts";

/** props の名前と分類 `props` と、要素がフォームの部品かどうか `form` から、要素を登録するときの設定を返す。 */
export function optionsOf(props: readonly PropType[], form: boolean): ElementOptions {
  const kinds = Object.fromEntries(props.map(({ name, kind }) => [name, kind]));
  return form ? { props: kinds, form: true } : { props: kinds };
}

/** `code` の中の位置 `position` にある要素の関数の、第 1 引数の型を解析する関数を表す。 */
export type ParamTypeOf = (code: string, position: number) => ParamType | undefined;

/**
 * 要素のファイル `file` の、要素の関数の第 1 引数の型を解析した結果 `type` を返す。
 * 型を解決できなかったときと、型がインデックスシグネチャを持つときと、props の名前が誤っているときは、ビルドのエラーにする。
 */
export function checkedProps<T extends ParamType>(file: string, type: T | undefined): T {
  if (type === undefined) {
    throw new CompileError(
      `${file}: Props の型を解決できないか、Props の型がオブジェクトの型ではありません。型の名前と、型を import するパスを確認してください。Props の型には、props の名前と型を列挙したオブジェクトの型を記述してください。ユニオン型、any、unknown は使用できません。`,
    );
  }
  if (type.indexed) {
    throw new CompileError(
      `${file}: Props の型には、インデックスシグネチャを使用できません。props の名前を列挙してください。`,
    );
  }
  const errors = checkPropNames(type.props.map(({ name }) => name));
  if (errors.length > 0) throw new CompileError(`${file}: ${errors.join("\n")}`);
  return type;
}

/** 要素の関数の第 2 引数の ctx を、デフォルト値を外して表す。 */
export type CtxParam = Extract<ESTree.ParamPattern, { type: "Identifier" | "ObjectPattern" }>;
