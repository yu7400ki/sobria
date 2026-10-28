import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isParameterDeclaration } from "typescript/ast/is";
import {
  API,
  SignatureKind,
  SymbolFlags,
  TypeFlags,
  type Checker,
  type Signature,
  type Snapshot,
  type Symbol as TypeSymbol,
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

/** JSDoc の説明と、説明より後に記述したタグを表す。 */
export interface DocComment {
  readonly description: string;
  readonly tags: readonly { readonly name: string; readonly text: string }[];
}

/** Props の型の 1 つのメンバーの、名前、分類、型の文字列、JSDoc を表す。 */
export interface PropDescription extends PropType {
  /** メンバーの型を文字列にしたものである。省略できるメンバーの型は、`undefined` を除外する。 */
  readonly type: string;
  readonly docs: DocComment;
  /** 分類が `function` のメンバーが、イベントとして発行する `CustomEvent` の `detail` の型の文字列である。ほかの分類では `undefined` である。 */
  readonly detail: string | undefined;
}

/** 関数の引数の、名前、型の文字列、省略できるかどうか、残余引数かどうかを表す。 */
export interface ParameterDescription {
  readonly name: string;
  readonly type: string;
  readonly optional: boolean;
  readonly rest: boolean;
}

/** `Ctx<M>` の `M` の 1 つのメンバーを表す。 */
export type ExposedDescription =
  | {
      readonly kind: "method";
      readonly name: string;
      readonly parameters: readonly ParameterDescription[];
      readonly returnType: string;
      readonly docs: DocComment;
    }
  | {
      readonly kind: "field";
      readonly name: string;
      readonly type: string;
      readonly readonly: boolean;
      readonly docs: DocComment;
    };

/** 要素の関数の JSDoc と、引数の型を解析した結果を表す。 */
export interface ElementDescription extends ParamType {
  /** 要素の関数の JSDoc である。 */
  readonly docs: DocComment;
  /** Props の型のメンバーである。宣言した順に並ぶ。 */
  readonly props: readonly PropDescription[];
  /** `Ctx<M>` の `M` のメンバーである。宣言した順に並ぶ。 */
  readonly exposed: readonly ExposedDescription[];
}

/** ディスクで作成、変更、削除されたファイルのパスを表す。 */
export interface FileChanges {
  readonly created?: readonly string[];
  readonly changed?: readonly string[];
  readonly deleted?: readonly string[];
}

/** TypeScript の型チェッカーで、要素の関数の引数の型を解析するオブジェクトを表す。 */
export interface TypeChecker {
  /**
   * 要素のファイル `file` を変換するコード `code` の、位置 `position` にある要素の関数の型から、第 1 引数の型を Props の型として解析する。
   * ほかのファイルが import した `file` の型は、ディスクの内容で解決する。
   * 第 1 引数の型から `undefined` と `null` を除外した型を解析する。
   * 第 1 引数が無いときと、除外した型がオブジェクトの型でないとき（ユニオン型、`any`、`unknown`、プリミティブなど）と、型チェッカーが解決できない型のときは、`undefined` を返す。
   */
  readonly param: (file: string, code: string, position: number) => ParamType | undefined;
  /**
   * 要素のファイル `file` を変換するコード `code` の、位置 `position` にある要素の関数の型から、Props の型と `Ctx<M>` の `M` を解析する。
   * `code` は、`export default function` で要素の関数を宣言したコードである。
   * 要素の関数の型を呼び出せないときと、Props の型として解析できないときは、`undefined` を返す。
   * 第 1 引数が無ければ `props` を、第 2 引数が無いか、`M` が `object` なら `exposed` を、空にする。
   */
  readonly describe: (
    file: string,
    code: string,
    position: number,
  ) => ElementDescription | undefined;
  /**
   * ディスクで作成、変更、削除されたファイルを通知する。次の解析から、通知した後のディスクの内容で型を解決する。
   * 削除されたファイルが、`param` か `describe` に渡した要素のファイルなら、そのファイルについて渡したコードを、以降の型の解決に使用しない。
   */
  readonly notify: (changes: FileChanges) => void;
  /** 型チェッカーのプロセスを終了する。 */
  readonly close: () => void;
}

/** rinka の `Slot` の型を import して、`slot` の型にするファイルの内容である。 */
const slotProbe = 'import type { Slot } from "rinka";\nexport declare const slot: Slot;\n';

/** `DetailMap` の型を宣言したモジュールのパスである。 */
const elementTypes = fileURLToPath(new URL("../shared/element.js", import.meta.url)).replaceAll(
  "\\",
  "/",
);

/** 要素のファイル `file` の、変換するコードを型チェッカーに渡す仮想のパスを返す。 */
const virtualPath = (file: string) => `${file}.rinka.tsx`;

/**
 * 要素のファイル `file` の要素の関数の型から、`props`、`details`、`exposed` を宣言するファイルの内容を返す。
 * `props` と `exposed` は、Props の型と `M` の各メンバーの型から、省略できるメンバーの `undefined` を除外した型を持つ。
 * `details` は、関数の型の props ごとに、要素の型が使う `DetailMap` の型で算出した `detail` の型を持つ。
 */
const typesProbe = (file: string) => `import type { Ctx } from "rinka";
import type { DetailMap } from ${JSON.stringify(elementTypes)};
import type Element from ${JSON.stringify(`./${basename(virtualPath(file))}`)};
type P = NonNullable<Parameters<typeof Element>[0]>;
type M = NonNullable<Parameters<typeof Element>[1]> extends Ctx<infer T> ? T : never;
export declare const props: { [K in keyof P]-?: P[K] };
export declare const details: DetailMap<P>;
export declare const exposed: { [K in keyof M]-?: M[K] };
`;

/**
 * tsconfig `config` のコンパイラの設定で、`config` が含むファイルを root にしたプログラムの型チェッカーを起動する。
 * `param` と `describe` に渡した要素のファイルの変換するコードも、root に追加する。
 */
export function createTypeChecker(options: { readonly config: string }): TypeChecker {
  const probe = join(dirname(options.config), "rinka-slot.ts");
  const api = new API({ cwd: dirname(options.config) });
  const { options: compilerOptions, fileNames } = api.parseConfigFile(options.config);
  /** 型チェッカーに渡したファイルのパスごとの内容である。 */
  const files = new Map([[probe, slotProbe]]);
  const program = () => ({
    rootFiles: [...new Set([...fileNames, ...files.keys()])],
    compilerOptions,
  });
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
  /** ファイルのパスごとの内容 `contents` を反映したスナップショットの型チェッカーを返す。 */
  const load = (contents: Readonly<Record<string, string>>): Checker => {
    const changes = Object.entries(contents).filter(([file, code]) => files.get(file) !== code);
    if (changes.length > 0) {
      const added = changes.some(([file]) => !files.has(file));
      for (const [file, code] of changes) files.set(file, code);
      update({
        fileSystem: { kind: "layer", files: Object.fromEntries(changes) },
        ...(added && { reconfigurePrograms: [{ id, ...program() }] }),
      });
    }
    return snapshot.getProject(id)!.checker;
  };
  /** Props の型 `type` のメンバーの名前と分類を返す。Props の型として解析できなければ `undefined` を返す。 */
  const membersOf = (checker: Checker, type: Type | undefined) => {
    if (type === undefined || type.flags & (TypeFlags.Any | TypeFlags.Unknown)) return undefined;
    const props = checker.getNonNullableType(type) ?? type;
    if (props.isUnionType() || !(props.flags & (TypeFlags.Object | TypeFlags.Intersection))) {
      return undefined;
    }
    const slot = checker.getTypeAtPosition(probe, slotProbe.indexOf("slot:"))?.getSymbol();
    const symbols = checker.getPropertiesOfType(props);
    const types = checker.getTypeOfSymbol(symbols);
    return {
      members: symbols.map((symbol, index) => ({
        symbol,
        kind: symbol.name === "children" ? "slot" : kindOf(checker, types[index], slot?.id),
      })),
      indexed: checker.getIndexInfosOfType(props).length > 0,
    };
  };
  return {
    param(file, code, position) {
      const virtual = virtualPath(file);
      const checker = load({ [virtual]: code });
      const [propsParam] = signatureAt(checker, virtual, position)?.getParameters() ?? [];
      const result = propsParam && membersOf(checker, checker.getTypeOfSymbol(propsParam));
      return (
        result && {
          props: result.members.map(({ symbol, kind }) => ({ name: symbol.name, kind })),
          indexed: result.indexed,
        }
      );
    },
    describe(file, code, position) {
      const types = `${file}.rinka-types.ts`;
      const typesCode = typesProbe(file);
      const virtual = virtualPath(file);
      const checker = load({ [virtual]: code, [types]: typesCode });
      const signature = signatureAt(checker, virtual, position);
      if (signature === undefined) return undefined;
      const [propsParam, ctxParam] = signature.getParameters();
      const result =
        propsParam === undefined
          ? { members: [], indexed: false }
          : membersOf(checker, checker.getTypeOfSymbol(propsParam));
      if (result === undefined) return undefined;
      /** 型を宣言するファイルの変数 `name` のプロパティ `property` の型を、文字列にして返す。プロパティが無ければ `unknown` を返す。 */
      const textOf = (name: string, property: string) => {
        const declared = checker.getTypeAtPosition(
          types,
          typesCode.indexOf(`const ${name}:`) + "const ".length,
        );
        const symbol = declared && checker.getPropertyOfType(declared, property);
        const type = symbol && checker.getTypeOfSymbol(symbol);
        return type ? checker.typeToString(type) : "unknown";
      };
      const props = result.members.map(({ symbol, kind }): PropDescription => ({
        name: symbol.name,
        kind,
        type: textOf("props", symbol.name),
        docs: docsOf(checker, symbol),
        detail: kind === "function" ? textOf("details", symbol.name) : undefined,
      }));
      const ctx = ctxParam && checker.getTypeOfSymbol(ctxParam);
      const methods = ctx && exposedType(checker, ctx);
      const exposed =
        methods === undefined
          ? []
          : describeExposed(checker, methods, (name) => textOf("exposed", name));
      const symbol = checker.getTypeAtPosition(virtual, position)?.getSymbol();
      return {
        docs: symbol ? docsOf(checker, symbol) : { description: "", tags: [] },
        props,
        indexed: result.indexed,
        exposed,
      };
    },
    notify(changes) {
      const deleted = changes.deleted ?? [];
      const removed = deleted.filter((file) => files.delete(virtualPath(file)));
      update({
        fileNotifications: {
          created: [...(changes.created ?? [])],
          changed: [...(changes.changed ?? [])],
          deleted: [...deleted],
        },
        ...(removed.length > 0 && { reconfigurePrograms: [{ id, ...program() }] }),
      });
    },
    close() {
      snapshot.dispose();
      api.close();
    },
  };
}

/** ファイル `file` の位置 `position` にある関数の型の、最初の呼び出しのシグネチャを返す。 */
function signatureAt(checker: Checker, file: string, position: number): Signature | undefined {
  const type = checker.getTypeAtPosition(file, position);
  return type && checker.getSignaturesOfType(type, SignatureKind.Call)[0];
}

/** `symbol` の JSDoc の説明とタグを返す。 */
function docsOf(checker: Checker, symbol: TypeSymbol): DocComment {
  return {
    description: checker.getDocumentationCommentOfSymbol(symbol),
    tags: checker
      .getJsDocTagsOfSymbol(symbol)
      .map(({ name, text }) => ({ name, text: text ?? "" })),
  };
}

/** `Ctx<M>` の型 `ctx` から、`M` の型を返す。`M` が `object` なら `undefined` を返す。 */
function exposedType(checker: Checker, ctx: Type): Type | undefined {
  const expose = checker.getPropertyOfType(ctx, "expose");
  const exposeType = expose && checker.getTypeOfSymbol(expose);
  const [signature] = exposeType ? checker.getSignaturesOfType(exposeType, SignatureKind.Call) : [];
  const [members] = signature?.getParameters() ?? [];
  const type = members && checker.getTypeOfSymbol(members);
  return type === undefined || type.flags & TypeFlags.NonPrimitive ? undefined : type;
}

/**
 * `Ctx<M>` の `M` の型 `type` のメンバーを、メソッドとフィールドにする。
 * フィールドの型の文字列は、`fieldText` にメンバーの名前を渡して取得する。
 */
function describeExposed(
  checker: Checker,
  type: Type,
  fieldText: (name: string) => string,
): ExposedDescription[] {
  return checker.getPropertiesOfType(type).map((symbol): ExposedDescription => {
    const docs = docsOf(checker, symbol);
    const accessor = symbol.flags & (SymbolFlags.GetAccessor | SymbolFlags.SetAccessor);
    const declared = checker.getTypeOfSymbol(symbol);
    const memberType = declared && (checker.getNonNullableType(declared) ?? declared);
    const [signature] =
      accessor || memberType === undefined
        ? []
        : checker.getSignaturesOfType(memberType, SignatureKind.Call);
    if (memberType && signature && checker.getPropertiesOfType(memberType).length === 0) {
      return {
        kind: "method",
        name: symbol.name,
        parameters: parametersOf(checker, signature),
        returnType: checker.typeToString(checker.getReturnTypeOfSignature(signature)),
        docs,
      };
    }
    return {
      kind: "field",
      name: symbol.name,
      type: fieldText(symbol.name),
      readonly: accessor
        ? !(symbol.flags & SymbolFlags.SetAccessor)
        : checker.isReadonlySymbol(symbol),
      docs,
    };
  });
}

/** シグネチャ `signature` の引数を返す。 */
function parametersOf(checker: Checker, signature: Signature): ParameterDescription[] {
  const parameters = signature.getParameters();
  return parameters.map((parameter, index) => ({
    name: parameter.name,
    type: parameterText(checker, parameter),
    optional: isOptional(parameter),
    rest: signature.hasRestParameter && index === parameters.length - 1,
  }));
}

/**
 * 引数 `parameter` の型の文字列を返す。
 * 引数が、型の引数を代入して作成した引数でなく、型注釈を持てば、型注釈の型の文字列にする。
 * そのほかの引数は、型チェッカーが解決した型の文字列にする。型注釈を持たない省略できる引数では、この型は `undefined` を含む。
 */
function parameterText(checker: Checker, parameter: TypeSymbol): string {
  const declaration =
    parameter.flags & SymbolFlags.Transient ? undefined : parameter.valueDeclaration?.resolve();
  if (declaration && isParameterDeclaration(declaration) && declaration.type) {
    return checker.typeToString(checker.getTypeFromTypeNode(declaration.type));
  }
  const type = checker.getTypeOfSymbol(parameter);
  return type ? checker.typeToString(type) : "unknown";
}

/** 引数 `parameter` を、`?` を付けるか、デフォルト値を付けて宣言したかどうかを返す。 */
function isOptional(parameter: TypeSymbol): boolean {
  const declaration = parameter.valueDeclaration?.resolve();
  return (
    declaration !== undefined &&
    isParameterDeclaration(declaration) &&
    (declaration.questionToken !== undefined || declaration.initializer !== undefined)
  );
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
