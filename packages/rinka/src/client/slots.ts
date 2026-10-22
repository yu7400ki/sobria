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
  /** スロットの名前ごとに、`<slot>` を作成した時点の owner を保持する。 */
  readonly owners: Map<string, Owner>;
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
 * owner が破棄されると、登録を取り消す。子要素は、次に `<slot>` を作成した時点で起動し直す。
 */
export function registerSlot(name: string): void {
  const owner = getOwner();
  const slots = owner ? getContext(HostContext) : null;
  if (!owner || !slots) return;
  slots.owners.set(name, owner);
  onCleanup(() => {
    if (slots.owners.get(name) === owner) slots.owners.delete(name);
  });
  for (const activate of slots.children.get(name) ?? []) activate(owner);
}

/** `insert` で挿入する内容と、その中で作成した子要素を、`slots` のホストの `name` のスロットに配置する。 */
export function insertIntoSlot(slots: HostSlots, name: string, insert: () => void): void {
  runWithOwner(createOwner(), () => {
    setContext(TargetContext, { slots, name });
    insert();
  });
}

/**
 * owner の下で呼び出す。スロットに配置する内容として作成した子要素なら、`<slot>` を作成した時点の owner の下で `activate` を呼び、`true` を返す。
 * `<slot>` を作成済みなら `activate` をすぐに呼ぶ。現在の owner が破棄されると、`activate` を呼ばなくなる。
 * スロットに配置する内容でなければ `false` を返す。
 */
export function activateInSlot(activate: (owner: Owner) => void): boolean {
  const target = getContext(TargetContext);
  if (!target) return false;
  const { slots, name } = target;
  let children = slots.children.get(name);
  if (!children) slots.children.set(name, (children = new Set()));
  children.add(activate);
  onCleanup(() => children.delete(activate));
  const owner = slots.owners.get(name);
  if (owner) activate(owner);
  return true;
}
