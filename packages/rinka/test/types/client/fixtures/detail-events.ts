// detail の型の規則の場合ごとに、onX の props と、そのイベントの型を記述する。
// test/types/client/detail.test-d.ts は ElementRef の型と Expected を比較し、
// test/node/element-manifest.test.ts はマニフェストのイベントの型と Expected の型注釈の文字列を比較する。

type Handler = (id: string) => void;

interface Callable {
  (count: number): void;
}

export type Props = {
  onNone: () => void;
  onOptional: (value?: string) => void;
  onUndefined: (value: number | undefined) => void;
  onNull: (value: string | null) => void;
  onBoth: (value?: string | null) => void;
  // prettier-ignore
  onParens: (value: (string | undefined)) => void;
  onVoid: (value: void) => void;
  onRest: (...values: number[]) => void;
  onAlias: Handler;
  onCallable: Callable;
  get onGetter(): (count: number) => void;
  set onSetter(fn: (reason: string) => void);
};

export type Expected = {
  none: CustomEvent<null>;
  optional: CustomEvent<string | null>;
  undefined: CustomEvent<number | null>;
  null: CustomEvent<string | null>;
  both: CustomEvent<string | null>;
  parens: CustomEvent<string | null>;
  void: CustomEvent<void | null>;
  rest: CustomEvent<number>;
  alias: CustomEvent<string>;
  callable: CustomEvent<number>;
  getter: CustomEvent<number>;
  setter: CustomEvent<string>;
};

export default function Detail(_props: Props) {
  return null;
}
