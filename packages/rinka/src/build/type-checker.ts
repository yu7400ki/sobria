import { dirname, join } from "node:path";

import {
  API,
  SignatureKind,
  TypeFlags,
  type Checker,
  type Snapshot,
  type Type,
} from "typescript/sync";

import type { PropKind } from "../shared/element.ts";

/** Props の型の 1 つのメンバーの、名前と分類を表す。 */
export interface PropType {
  readonly name: string;
  readonly kind: PropKind;
}

/** 要素の関数の引数の型を解析した結果を表す。 */
export interface ParamType {
  /** 型のプロパティの名前と分類である。宣言した順に並ぶ。 */
  readonly props: readonly PropType[];
  /** 型がインデックスシグネチャを持つかどうかである。 */
  readonly indexed: boolean;
}

/** TypeScript の型チェッカーで、要素の関数の引数の型を解析するオブジェクトを表す。 */
export interface TypeChecker {
  /**
   * `code` を `file` の内容として、`code` の中の位置 `position` にある式や宣言の型を、要素の関数の引数の型として解析する。
   * 型から `undefined` と `null` を除外した型を、Props の型として解析する。
   * 除外した型がオブジェクトの型でないとき（ユニオン型、`any`、`unknown`、プリミティブなど）と、型チェッカーが解決できない型のときは、`undefined` を返す。
   */
  readonly param: (file: string, code: string, position: number) => ParamType | undefined;
  /** ディスクで変更されたファイル `files` を通知する。次の解析から、変更後の内容で型を解決する。 */
  readonly changed: (files: readonly string[]) => void;
  /** 型チェッカーのプロセスを終了する。 */
  readonly close: () => void;
}

/** rinka の `Slot` の型を import して、`slot` の型にするファイルの内容である。 */
const slotProbe = 'import type { Slot } from "rinka";\nexport declare const slot: Slot;\n';

/**
 * tsconfig `config` のコンパイラの設定で、`config` が含むファイルを root にしたプログラムの型チェッカーを起動する。
 * `param` に渡したファイルも、root に加える。
 */
export function createTypeChecker(options: { readonly config: string }): TypeChecker {
  const probe = join(dirname(options.config), "rinka-slot.ts");
  const api = new API({ cwd: dirname(options.config) });
  const { options: compilerOptions, fileNames } = api.parseConfigFile(options.config);
  const roots = new Set([probe, ...fileNames]);
  const files = new Map([[probe, slotProbe]]);
  const program = () => ({ rootFiles: [...roots], compilerOptions });
  const created = api.createSnapshot({
    createPrograms: [program()],
    fileSystem: { kind: "layer", files: Object.fromEntries(files) },
  });
  const [{ id }] = created.operation.createdPrograms;
  let snapshot: Snapshot = created;
  /** 現在のスナップショットを、`changes` を加えたものに置換する。 */
  const update = (changes: Parameters<Snapshot["update"]>[0]) => {
    const previous = snapshot;
    snapshot = previous.update({ ...changes, ensurePrograms: true });
    previous.dispose();
  };
  return {
    param(file, code, position) {
      const added = !roots.has(file);
      if (added || files.get(file) !== code) {
        roots.add(file);
        files.set(file, code);
        update({
          fileSystem: { kind: "layer", files: { [file]: code } },
          ...(added && { reconfigurePrograms: [{ id, ...program() }] }),
        });
      }
      const { checker } = snapshot.getProject(id)!;
      const type = checker.getTypeAtPosition(file, position);
      const slot = checker.getTypeAtPosition(probe, slotProbe.indexOf("slot:"))?.getSymbol();
      if (type === undefined || type.flags & (TypeFlags.Any | TypeFlags.Unknown)) return undefined;
      const props = checker.getNonNullableType(type) ?? type;
      if (props.isUnionType() || !(props.flags & (TypeFlags.Object | TypeFlags.Intersection))) {
        return undefined;
      }
      const symbols = checker.getPropertiesOfType(props);
      const types = checker.getTypeOfSymbol(symbols);
      return {
        props: symbols.map((symbol, index) => ({
          name: symbol.name,
          kind: symbol.name === "children" ? "slot" : kindOf(checker, types[index], slot?.id),
        })),
        indexed: checker.getIndexInfosOfType(props).length > 0,
      };
    },
    changed(changedFiles) {
      update({ fileNotifications: { changed: [...changedFiles] } });
    },
    close() {
      snapshot.dispose();
      api.close();
    },
  };
}

/** props の型 `type` の分類を返す。`slot` は、`Slot` の型の symbol の ID である。 */
function kindOf(checker: Checker, type: Type | undefined, slot: number | undefined): PropKind {
  if (type === undefined) return "unknown";
  if (slot !== undefined && type.getSymbol()?.id === slot) return "slot";
  if (type.flags & TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint && constraint !== type ? kindOf(checker, constraint, slot) : "unknown";
  }
  if (type.flags & TypeFlags.BooleanLike) return "boolean";
  if (type.isUnionType()) {
    const kinds = new Set(
      (type.getTypes() ?? [])
        .filter((member) => !(member.flags & (TypeFlags.Undefined | TypeFlags.Null)))
        .map((member) => kindOf(checker, member, slot)),
    );
    const [kind] = kinds;
    return kinds.size === 1 && kind !== undefined ? kind : "unknown";
  }
  if (type.flags & TypeFlags.StringLike) return "string";
  if (type.flags & TypeFlags.NumberLike) return "number";
  if (type.isIntersectionType()) {
    const primitive = (type.getTypes() ?? [])
      .map((member) => kindOf(checker, member, slot))
      .find((kind) => kind === "string" || kind === "number" || kind === "boolean");
    if (primitive !== undefined) return primitive;
  }
  if (type.flags & (TypeFlags.Object | TypeFlags.Intersection | TypeFlags.NonPrimitive)) {
    const callable = checker.getSignaturesOfType(type, SignatureKind.Call).length > 0;
    return callable && checker.getPropertiesOfType(type).length === 0 ? "function" : "object";
  }
  return "unknown";
}
