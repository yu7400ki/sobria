import { htmlElementMembers, structuralMembers } from "./dom-names.generated.ts";
import { propToAttribute } from "./names.ts";

/** ホストで意味を持つ属性の名前と、props にできない理由と、代わりの名前の例。小文字で照合する。 */
const hostAttributes: Readonly<Record<string, readonly [reason: string, alternative: string]>> = {
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
};

/** rinka がフォームの部品のホストに付ける API の名前。 */
const formMembers: ReadonlySet<string> = new Set([
  "form",
  "labels",
  "validity",
  "validationMessage",
  "willValidate",
  "checkValidity",
  "reportValidity",
]);

/** Custom Element のライフサイクルのコールバックの名前。 */
const lifecycleCallbacks: ReadonlySet<string> = new Set([
  "connectedCallback",
  "disconnectedCallback",
  "adoptedCallback",
  "attributeChangedCallback",
  "connectedMoveCallback",
  "formAssociatedCallback",
  "formResetCallback",
  "formDisabledCallback",
  "formStateRestoreCallback",
]);

/** 名前の無いスロットの props。ホストのプロパティにならないので、`Element.children` と衝突しない。 */
const slotChildren = "children";

function propNameError(name: string): string | undefined {
  const head = `"${name}" は props の名前にできません。`;
  if (name === "ref") return `${head}rinka が要素への ref として扱うためです。`;
  if (name === "key") return `${head}rinka が一覧の項目を区別するために使用するためです。`;
  if (name.startsWith("load:")) {
    return `${head}rinka が要素を読み込むタイミングの指定として扱うためです。`;
  }
  const host = hostAttributes[name.toLowerCase()];
  if (host) return `${head}${host[0]}${host[1]} のような名前を使用してください。`;
  if (/^(aria|data)[A-Z]/.test(name)) {
    return `${head}aria-* と data-* の属性は、そのままホストに渡すためです。代わりに label のような名前を使用してください。`;
  }
  if (formMembers.has(name)) {
    return `${head}rinka がフォームの部品のホストに ${name} を付けるためです。要素の役割を表す別の名前を使用してください。`;
  }
  if (name !== slotChildren && htmlElementMembers.has(name)) {
    return `${head}props はホストのプロパティになり、HTMLElement の ${name} を上書きするためです。要素の役割を表す別の名前を使用してください。`;
  }
  return undefined;
}

/** Props の型に記述した props の名前を検査し、問題ごとのメッセージを返す。 */
export function checkPropNames(names: readonly string[]): string[] {
  const errors: string[] = [];
  const byAttribute = new Map<string, string>();
  for (const name of names) {
    const error = propNameError(name);
    if (error) errors.push(error);
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

/** `ctx.expose` で公開する名前を検査し、公開できない名前ならメッセージを返す。 */
export function checkExposeName(name: string, propNames: readonly string[]): string | undefined {
  const head = `"${name}" は expose で公開できません。`;
  if (structuralMembers.has(name) || lifecycleCallbacks.has(name)) {
    return `${head}rinka のランタイムと、ページの JS によるホストの操作が壊れるためです。`;
  }
  if (formMembers.has(name)) return `${head}rinka がフォームへの参加に使用するためです。`;
  if (propNames.includes(name)) return `${head}同じ名前の props の値を置き換えるためです。`;
  return undefined;
}
