import { formMembers, lifecycleCallbacks } from "./host-members.ts";
import { htmlElementMembers } from "./html-element-members.generated.ts";
import { propToAttribute, reservedProp, type ReservedProp } from "./names.ts";

/** ホストで意味を持つ属性の名前を、props にできない理由と代わりの名前の例に対応させる。名前は小文字で照合する。 */
const hostAttributes: ReadonlyMap<string, readonly [reason: string, alternative: string]> = new Map(
  [
    ["id", ["ホストの id 属性になるためです。", "識別子には itemId"]],
    ["class", ["ホストの class 属性になるためです。", "見た目の種類には variant"]],
    ["style", ["ホストの style 属性になるためです。", "見た目の種類には variant"]],
    ["slot", ["ホストを配置するスロットの名前になるためです。", "代わりに slotName"]],
    ["part", ["ホストの part 属性になるためです。", "代わりに partName"]],
    ["exportparts", ["ホストの exportparts 属性になるためです。", "代わりに exportedParts"]],
    ["is", ["カスタマイズされた組み込み要素を指定する属性になるためです。", "種類には kind"]],
    ["role", ["ホストの ARIA のロールになるためです。", "種類には kind"]],
    ["title", ["要素の全体にツールチップが表示されるためです。", "見出しには heading"]],
    ["hidden", ["ホストが非表示になるためです。", "表示の切り替えには open"]],
    ["lang", ["ホストの言語になるためです。", "代わりに locale"]],
    ["dir", ["ホストの文字の方向になるためです。", "代わりに direction"]],
    ["tabindex", ["ホストのフォーカスの順序になるためです。", "代わりに order"]],
    ["inert", ["ホストを操作できなくなるためです。", "代わりに locked"]],
    ["popover", ["ホストがポップオーバーになるためです。", "代わりに overlay"]],
    ["draggable", ["ホストをドラッグできるようになるためです。", "代わりに movable"]],
    ["accesskey", ["ホストのアクセスキーになるためです。", "代わりに shortcut"]],
    [
      "autofocus",
      ["ページを開いたときにホストにフォーカスが移るためです。", "代わりに focusOnOpen"],
    ],
    ["contenteditable", ["ホストの内容を編集できるようになるためです。", "代わりに editable"]],
    ["spellcheck", ["ホストのスペルチェックを切り替えるためです。", "代わりに checkSpelling"]],
    ["translate", ["ホストを翻訳するかどうかを切り替えるためです。", "代わりに translatable"]],
    ["nonce", ["ホストの CSP の nonce になるためです。", "代わりに token"]],
    [
      "enterkeyhint",
      ["仮想キーボードの Enter キーの表示を切り替えるためです。", "代わりに enterLabel"],
    ],
    ["inputmode", ["仮想キーボードの種類を切り替えるためです。", "代わりに keyboard"]],
  ],
);

/** 予約された props の種類を、props にできない理由と代わりの名前の例に対応させる。 */
const reservedProps: Readonly<
  Record<ReservedProp, readonly [reason: string, alternative: string]>
> = {
  ref: ["rinka が要素への ref として扱うためです。", "内側のノードを受け取る関数には inputRef"],
  key: ["rinka が一覧の項目を区別するために使用するためです。", "識別子には itemKey"],
  "load:": [
    "rinka が要素を読み込むタイミングの指定として扱うためです。",
    "読み込みの状態には loadState",
  ],
};

const ariaOrData: readonly [reason: string, alternative: string] = [
  "rinka が aria-* と data-* の属性を、そのままホストに渡すためです。",
  "代わりに label",
];

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
  const host = hostAttributes.get(name.toLowerCase());
  if (host) return host;
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
