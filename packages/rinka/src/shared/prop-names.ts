import { formMembers, lifecycleCallbacks } from "./host-members.ts";
import { htmlElementMembers } from "./html-element-members.generated.ts";
import { propToAttribute, reservedProp, type ReservedProp } from "./names.ts";

/** ホストで意味を持つ属性の名前を、props にできない理由と代わりの名前の例に対応させる。名前は小文字で照合する。 */
const hostAttributes = {
  id: ["ホストの id 属性になるためです。", "識別子には itemId"],
  class: ["ホストの class 属性になるためです。", "見た目の種類には variant"],
  style: ["ホストの style 属性になるためです。", "見た目の種類には variant"],
  slot: ["ホストを配置するスロットの名前になるためです。", "代わりに slotName"],
  part: ["ホストの part 属性になるためです。", "代わりに partName"],
  exportparts: ["ホストの exportparts 属性になるためです。", "代わりに exportedParts"],
  is: ["カスタマイズされた組み込み要素を指定する属性になるためです。", "種類には kind"],
  role: ["ホストの ARIA のロールになるためです。", "種類には kind"],
  title: ["要素の全体にツールチップが表示されるためです。", "見出しには heading"],
  hidden: ["ホストが非表示になるためです。", "表示の切り替えには open"],
  lang: ["ホストの言語になるためです。", "代わりに locale"],
  dir: ["ホストの文字の方向になるためです。", "代わりに direction"],
  tabindex: ["ホストのフォーカスの順序になるためです。", "代わりに order"],
  inert: ["ホストを操作できなくなるためです。", "代わりに locked"],
  popover: ["ホストがポップオーバーになるためです。", "代わりに overlay"],
  draggable: ["ホストをドラッグできるようになるためです。", "代わりに movable"],
  accesskey: ["ホストのアクセスキーになるためです。", "代わりに shortcut"],
  autofocus: ["ページを開いたときにホストにフォーカスが移るためです。", "代わりに focusOnOpen"],
  contenteditable: ["ホストの内容を編集できるようになるためです。", "代わりに editable"],
  spellcheck: ["ホストのスペルチェックを切り替えるためです。", "代わりに checkSpelling"],
  translate: ["ホストを翻訳するかどうかを切り替えるためです。", "代わりに translatable"],
  nonce: ["ホストの CSP の nonce になるためです。", "代わりに token"],
  enterkeyhint: ["仮想キーボードの Enter キーの表示を切り替えるためです。", "代わりに enterLabel"],
  inputmode: ["仮想キーボードの種類を切り替えるためです。", "代わりに keyboard"],
} as const satisfies Record<string, readonly [reason: string, alternative: string]>;

/** ホストで意味を持つ属性の名前を表す。 */
export type HostAttribute = keyof typeof hostAttributes;

const isHostAttribute = (name: string): name is HostAttribute =>
  Object.hasOwn(hostAttributes, name);

/** 予約された props の種類を、props にできない理由と代わりの名前の例に対応させる。 */
const reservedProps = {
  ref: ["rinka が要素への ref として扱うためです。", "内側のノードを受け取る関数には inputRef"],
  key: ["rinka が一覧の項目を区別するために使用するためです。", "識別子には itemKey"],
  "load:": [
    "rinka が要素を読み込むタイミングの指定として扱うためです。",
    "読み込みの状態には loadState",
  ],
} as const satisfies Record<ReservedProp, readonly [reason: string, alternative: string]>;

const ariaOrData = [
  "rinka が aria-* と data-* の属性を、そのままホストに渡すためです。",
  "代わりに label",
] as const;

/**
 * ホストのプロパティになる名前を、props にできない理由に対応させる。名前は大文字と小文字を区別して照合する。
 * `children` は含めない。
 */
const hostMembers = new Map<string, string>([
  ...htmlElementMembers
    .filter((name) => name !== "children")
    .map((name): [string, string] => [
      name,
      `props はホストのプロパティになり、ホストの ${name} を上書きするためです。`,
    ]),
  ...formMembers.map((name): [string, string] => [
    name,
    `rinka がフォームの部品のホストに ${name} を付与するためです。`,
  ]),
  ...lifecycleCallbacks.map((name): [string, string] => [
    name,
    "Custom Element のライフサイクルのコールバックと衝突するためです。",
  ]),
]);

/** props にできない理由と、代わりの名前の例を返す。props にできる名前なら `undefined` を返す。 */
function reasonOf(name: string): readonly [reason: string, alternative?: string] | undefined {
  const reserved = reservedProp(name);
  if (reserved) return reservedProps[reserved];
  if (/^(aria|data)[A-Z]/.test(name)) return ariaOrData;
  const lower = name.toLowerCase();
  if (isHostAttribute(lower)) return hostAttributes[lower];
  const member = hostMembers.get(name);
  return member === undefined ? undefined : [member];
}

/** Props の型に記述した props の名前を検査し、問題ごとのメッセージを返す。 */
export function checkPropNames(names: readonly string[]): string[] {
  const errors: string[] = [];
  const byAttribute = new Map<string, string>();
  for (const name of names) {
    const reason = reasonOf(name);
    if (reason) {
      const [why, alternative] = reason;
      const advice = alternative
        ? `${alternative} のような名前を使用してください。`
        : "要素の役割を表す別の名前を使用してください。";
      errors.push(`"${name}" は props の名前にできません。${why}${advice}`);
    }
    const attribute = propToAttribute(name);
    const other = byAttribute.get(attribute);
    if (other === undefined) byAttribute.set(attribute, name);
    else {
      errors.push(
        `"${other}" と "${name}" は、どちらも属性名 ${attribute} になります。どちらかの名前を変更してください。`,
      );
    }
  }
  return errors;
}

/** ホストのプロパティになる名前を表す。`children` は含めない。 */
type HostMember =
  | Exclude<(typeof htmlElementMembers)[number], "children">
  | (typeof formMembers)[number]
  | (typeof lifecycleCallbacks)[number];

/** 名前 `K` の予約された props の種類を表す。予約されていなければ `never` を表す。 */
type ReservedOf<K extends string> = K extends `load:${string}` ? "load:" : Extract<K, ReservedProp>;

/** 名前 `K` が `aria` か `data` と大文字で始まるなら `true` を表す。 */
type IsAriaOrData<K extends string> = K extends `${"aria" | "data"}${infer First}${string}`
  ? First extends Lowercase<First>
    ? false
    : true
  : false;

/** 名前 `K` がホストのプロパティになる理由を表す。ホストのプロパティにならなければ `never` を表す。 */
type MemberReason<K extends string> = K extends (typeof lifecycleCallbacks)[number]
  ? "Custom Element のライフサイクルのコールバックと衝突するためです。"
  : K extends (typeof formMembers)[number]
    ? `rinka がフォームの部品のホストに ${K} を付与するためです。`
    : K extends HostMember
      ? `props はホストのプロパティになり、ホストの ${K} を上書きするためです。`
      : never;

/** 名前 `K` を props にできない理由と、代わりの名前の例を表す。props にできる名前なら `never` を表す。 */
type ReasonOf<K extends string> = [ReservedOf<K>] extends [never]
  ? IsAriaOrData<K> extends true
    ? typeof ariaOrData
    : Lowercase<K> extends HostAttribute
      ? (typeof hostAttributes)[Lowercase<K>]
      : [MemberReason<K>] extends [never]
        ? never
        : readonly [MemberReason<K>]
  : (typeof reservedProps)[ReservedOf<K>];

/** 理由 `R` から、props にできない名前 `K` のメッセージを作成する。 */
type ReasonMessage<K extends string, R> = R extends readonly [
  infer Why extends string,
  ...infer Rest,
]
  ? `"${K}" は props の名前にできません。${Why}${Rest extends readonly [
      infer Alternative extends string,
    ]
      ? `${Alternative} のような名前を使用してください。`
      : "要素の役割を表す別の名前を使用してください。"}`
  : never;

/** 名前 `K` が props にできない名前なら、ビルドのエラーと同じメッセージを表す。props にできる名前なら `never` を表す。 */
export type PropNameError<K extends string> = ReasonMessage<K, ReasonOf<K>>;

/** Props の型 `T` のうち、props にできない名前のキーの型を、`PropNameError` のメッセージの型にする。 */
type CheckedProps<T> = {
  [K in keyof T]: K extends string
    ? [PropNameError<K>] extends [never]
      ? T[K]
      : PropNameError<K>
    : T[K];
};

/** 要素の Props の型 `T` を表す。`T` のキーに props にできない名前があると、型エラーになる。 */
export type Props<T extends CheckedProps<T>> = T;
