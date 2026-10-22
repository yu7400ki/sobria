import {
  createContext,
  createOwner,
  getContext,
  getOwner,
  onCleanup,
  runWithOwner,
  setContext,
  type Owner,
} from "@solidjs/signals";

/** 要素のインスタンスごとの、スロットの状態を表す。 */
export interface HostSlots {
  /** スロットの名前ごとに、最後に作成した `<slot>` の登録を保持する。登録は、`<slot>` を作成した時点の owner を持つ。 */
  readonly owners: Map<string, { readonly owner: Owner }>;
  /** スロットの名前ごとに、そのスロットに配置した子要素を起動する関数を保持する。 */
  readonly children: Map<string, Set<(owner: Owner) => void>>;
}

/** Light DOM の内容を挿入する先のホストと、スロットの名前を表す。 */
interface SlotTarget {
  readonly slots: HostSlots;
  readonly name: string;
}

const HostContext = createContext<HostSlots | null>(null);
const TargetContext = createContext<SlotTarget | null>(null);

/** 空のスロットの状態を作成する。 */
export const createHostSlots = (): HostSlots => ({ owners: new Map(), children: new Map() });

/** 現在の owner の下で作成する要素を、`slots` のホストの描画の範囲の要素として扱い、外側のホストのスロットを待たずに起動する。 */
export function enterHost(slots: HostSlots): void {
  setContext(HostContext, slots);
  setContext(TargetContext, null);
}

/**
 * 描画の範囲で `<slot>` を作成したことを、ホストに登録し、そのスロットに配置した子要素を現在の owner の下で起動する。
 * `<slot>` を作成した計算の後始末で、登録を取り消す。後始末の前に同じ名前の `<slot>` を登録し直していれば、新しい登録を残す。
 * 子要素は、次に `<slot>` を作成した時点で起動し直す。
 */
export function registerSlot(name: string): void {
  const owner = getOwner();
  const slots = owner ? getContext(HostContext) : null;
  if (!owner || !slots) return;
  const registration = { owner };
  slots.owners.set(name, registration);
  onCleanup(() => {
    if (slots.owners.get(name) === registration) slots.owners.delete(name);
  });
  for (const activate of slots.children.get(name) ?? []) activate(owner);
}

/**
 * `insert` で挿入する内容と、その中で作成した子要素を、`slots` のホストの、props の名前 `prop` のスロットに配置する。
 * `children` は名前の無いスロットになる。`insert` は、挿入するノードを変換する関数を受け取る。
 * 名前付きのスロットでは、その関数は要素に `slot` 属性を付与し、テキストを `<span slot>` で包む。
 */
export function placeInSlot(
  slots: HostSlots,
  prop: string,
  insert: (place?: (node: Node) => Node) => void,
): void {
  const name = prop === "children" ? "" : prop;
  runWithOwner(createOwner(), () => {
    setContext(TargetContext, { slots, name });
    insert(name === "" ? undefined : (node) => assignSlot(node, name));
  });
}

/** 名前付きのスロットに配置するノードを返す。要素には `slot` 属性を付与し、テキストは `<span slot>` で包む。 */
function assignSlot(node: Node, name: string): Node {
  if (node instanceof Element) {
    node.setAttribute("slot", name);
    return node;
  }
  if (!(node instanceof Text)) return node;
  const span = document.createElement("span");
  span.setAttribute("slot", name);
  span.append(node);
  return span;
}

/**
 * owner の下で呼び出す。スロットに配置する内容として作成した子要素なら、`<slot>` を作成した時点の owner の下で `activate` を呼び、`true` を返す。
 * `<slot>` を作成済みなら `activate` をすぐに呼ぶ。現在の owner が破棄されると、`activate` を呼ばなくなる。
 * スロットに配置する内容でなければ `false` を返す。
 */
export function activateInSlot(activate: (owner: Owner) => void): boolean {
  const target = getContext(TargetContext);
  if (!target) return false;
  onCleanup(addChild(target.slots, target.name, activate));
  return true;
}

/**
 * `slots` のホストの `name` のスロットに配置した子要素を、そのスロットの `<slot>` を作成した時点の owner の下で起動する。
 * `<slot>` を作成済みなら `activate` をすぐに呼ぶ。戻り値の関数を呼ぶと、`activate` を呼ばなくなる。
 */
export function addChild(
  slots: HostSlots,
  name: string,
  activate: (owner: Owner) => void,
): () => void {
  let children = slots.children.get(name);
  if (!children) slots.children.set(name, (children = new Set()));
  children.add(activate);
  const owner = slots.owners.get(name)?.owner;
  if (owner) activate(owner);
  return () => children.delete(activate);
}
