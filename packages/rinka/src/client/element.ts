import {
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  NotReadyError,
  onCleanup,
  onSettled,
  runWithOwner,
  untrack,
  type Owner,
} from "@solidjs/signals";

import {
  elementInfo,
  type AttributeType,
  type Ctx,
  type ElementComponent,
  type ElementOptions,
} from "../shared/element.ts";
import {
  customEventName,
  isEventProp,
  listenerEventName,
  propToAttribute,
} from "../shared/names.ts";
import type { ClientNode } from "../shared/nodes.ts";
import { bind, callRef, insert, isFunction, setter } from "./dom.ts";
import {
  activateInSlot,
  createHostSlots,
  enterHost,
  insertIntoSlot,
  type HostSlots,
} from "./slots.ts";

/** 要素を描画する関数を表す。 */
export type ElementFn<P, M extends object> = (props: P, ctx: Ctx<M>) => unknown;

/** props の値か、値を読み取る関数を表す。読み取る関数は、親が渡した関数か、それを包んだ親の owner の memo である。 */
type Source = { readonly value: unknown } | { readonly read: () => unknown };

/** props の 1 つを表す。値はすぐに読み取れ、`track` を呼んだ計算は、値を書き込んだ後の flush で再び実行される。 */
interface Prop {
  source: Source;
  readonly track: () => void;
  readonly trigger: () => void;
}

/** 要素のインスタンスの状態を表す。 */
interface Instance {
  /** props の名前ごとの状態。要素の寿命の間は同じ状態を保持する。 */
  readonly props: ReadonlyMap<string, Prop>;
  /** 関数として宣言した props の名前。 */
  readonly functionProps: ReadonlySet<string>;
  /** スロットになる props の名前。`children` を含む。 */
  readonly slotNames: ReadonlySet<string>;
  /** スロットの状態。 */
  readonly slots: HostSlots;
  /** `owner` の下でインスタンスを起動する。 */
  readonly activate: (owner: Owner | null) => void;
  /** 親の owner の下で起動したかどうか。 */
  owned: boolean;
  /** 起動していれば、描画の範囲を破棄する関数。 */
  dispose?: () => void;
  /** 起動した後に呼ぶ、要素への `ref`。 */
  ref?: (host: HTMLElement) => unknown;
  /** まだ呼んでいない `onMount` の関数。 */
  mounts: (() => void)[];
  /** 最初の内容を表示したかどうか。 */
  settled: boolean;
}

const instances = new WeakMap<HTMLElement, Instance>();

function convert(value: string | null, type: AttributeType | undefined): unknown {
  if (value === null) return undefined;
  if (type === "number") return Number(value);
  if (type === "boolean") return value !== "false";
  return value;
}

const readSource = (source: Source): unknown => ("read" in source ? source.read() : source.value);

function createProp(source: Source): Prop {
  const [track, trigger] = runWithOwner(null, () =>
    createSignal(undefined, { equals: false, ownedWrite: true }),
  );
  return { source, track, trigger: () => trigger(undefined) };
}

function write(prop: Prop, source: Source): void {
  prop.source = source;
  prop.trigger();
}

/** ホストのプロパティとして、props の値を追跡せずに読み取る。値が未解決なら `undefined` を返す。 */
function peek(prop: Prop): unknown {
  try {
    return untrack(() => readSource(prop.source));
  } catch (error) {
    if (error instanceof NotReadyError) return undefined;
    throw error;
  }
}

/** 接続していて、最初の内容を表示していれば、まだ呼んでいない `onMount` の関数を呼ぶ。 */
function runMounts(host: HTMLElement, instance: Instance): void {
  if (!host.isConnected || !instance.settled) return;
  const mounts = instance.mounts;
  instance.mounts = [];
  for (const mount of mounts) mount();
}

/** `fn` を要素として、`tag` の名前で Custom Element に登録する。 */
export function defineElement<P, M extends object = object>(
  tag: string,
  fn: ElementFn<P, M>,
  options: ElementOptions,
): ElementComponent<P, M> {
  const types = options.types ?? {};
  const functionProps: ReadonlySet<string> = new Set(options.functionProps);
  const slotNames: ReadonlySet<string> = new Set(["children", ...(options.slots ?? [])]);
  const unobserved = new Set([...functionProps, ...slotNames]);
  const propOfAttribute = new Map(
    options.props
      .filter((name) => !unobserved.has(name))
      .map((name) => [propToAttribute(name), name]),
  );

  /** 要素の関数に渡す props を、インスタンスの props の状態から作成する。 */
  function createProps(host: HTMLElement, instance: Instance): object {
    const props = {};
    for (const [name, prop] of instance.props) {
      const get = () => {
        prop.track();
        return readSource(prop.source);
      };
      if (functionProps.has(name) && isEventProp(name)) {
        const dispatch = (detail?: unknown) =>
          host.dispatchEvent(
            new CustomEvent(customEventName(name), { detail, bubbles: true, composed: true }),
          );
        Object.defineProperty(props, name, { enumerable: true, get: () => get() ?? dispatch });
      } else {
        Object.defineProperty(props, name, { enumerable: true, get });
      }
    }
    return props;
  }

  /**
   * `owner` の下に root を作成して要素の関数を描画し、要素への `ref` を呼ぶ。
   * root を破棄すると、`instance.dispose` を `undefined` にし、まだ呼んでいない `onMount` の関数を捨てる。
   */
  function activate(host: HTMLElement, instance: Instance, owner: Owner | null): void {
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadow.replaceChildren();
    instance.owned = owner !== null;
    instance.settled = false;
    runWithOwner(owner, () =>
      createRoot((dispose) => {
        instance.dispose = dispose;
        enterHost(instance.slots);
        onCleanup(() => {
          instance.dispose = undefined;
          instance.mounts = [];
        });
        const ctx: Ctx<M> = {
          host,
          onMount: (mount) => instance.mounts.push(mount),
          expose: (members) => {
            Object.defineProperties(host, Object.getOwnPropertyDescriptors(members));
          },
        };
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const props = createProps(host, instance) as P;
        insert(
          shadow,
          untrack(() => fn(props, ctx)),
        );
        if (instance.ref) callRef(instance.ref, host);
        onSettled(() => {
          instance.settled = true;
          runMounts(host, instance);
        });
      }),
    );
  }

  class RinkaElement extends HTMLElement {
    static observedAttributes = [...propOfAttribute.keys()];

    constructor() {
      super();
      const props = new Map<string, Prop>();
      for (const name of options.props) {
        if (slotNames.has(name)) continue;
        const prop = createProp({ value: Object.getOwnPropertyDescriptor(this, name)?.value });
        props.set(name, prop);
        Object.defineProperty(this, name, {
          configurable: true,
          enumerable: true,
          get: () => peek(prop),
          set: (value: unknown) => {
            write(prop, { value });
          },
        });
      }
      const instance: Instance = {
        props,
        functionProps,
        slotNames,
        slots: createHostSlots(),
        activate: (owner) => activate(this, instance, owner),
        owned: false,
        mounts: [],
        settled: false,
      };
      instances.set(this, instance);
    }

    attributeChangedCallback(attribute: string, _old: string | null, value: string | null): void {
      const name = propOfAttribute.get(attribute);
      if (name === undefined) return;
      write(instances.get(this)!.props.get(name)!, { value: convert(value, types[name]) });
    }

    connectedCallback(): void {
      const instance = instances.get(this)!;
      if (instance.dispose) runMounts(this, instance);
      else if (!instance.owned) {
        queueMicrotask(() => {
          if (this.isConnected && !instance.dispose) instance.activate(null);
        });
      }
    }

    disconnectedCallback(): void {
      const instance = instances.get(this)!;
      if (instance.owned) return;
      queueMicrotask(() => {
        if (!this.isConnected) instance.dispose?.();
      });
    }
  }

  customElements.define(tag, RinkaElement);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const component = ((props: P, ctx: Ctx<M>) => fn(props, ctx)) as (
    props: P,
    ctx: Ctx<M>,
  ) => ClientNode;
  return Object.assign(component, { [elementInfo]: { tag, options } });
}

/**
 * JSX の中で、要素のインスタンスを作成する。
 * `options.props` に名前がある値は props に設定し、関数の値（関数の props を除く）と getter は、owner があれば親の owner の memo にする。
 * それ以外の値と `key` はホストの属性にし、props に無い `onX` の関数はホストのリスナーにする。
 * `children` とスロットの props の内容は Light DOM に配置し、その中の子要素は、ホストがそのスロットの `<slot>` を作成した後に起動する。
 * スロットに置く内容でなければ、owner があればその owner の下で同期的に起動する。owner が無ければ、接続した後に最上位の要素として起動する。
 * 要素への `ref` は、起動した後に呼ぶ。
 */
export function createElementInstance(
  component: ElementComponent<unknown>,
  props: Record<string, unknown>,
  key?: string,
): ClientNode {
  const host = document.createElement(component[elementInfo].tag);
  const instance = instances.get(host)!;
  const owner = getOwner();
  const derive = (read: () => unknown): Source => ({ read: owner ? createMemo(read) : read });
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(props))) {
    if (name === "ref") continue;
    const getter = descriptor.get;
    if (instance.slotNames.has(name)) {
      const content: unknown = getter ? () => getter.call(props) as unknown : descriptor.value;
      const slot = name === "children" ? "" : name;
      insertIntoSlot(instance.slots, slot, () =>
        insert(host, content, slot === "" ? undefined : (node) => assignSlot(node, slot)),
      );
      continue;
    }
    const prop = instance.props.get(name);
    if (getter) {
      const read = () => getter.call(props) as unknown;
      if (prop) write(prop, derive(read));
      else {
        const listener = isEventProp(name) ? untrack(read) : undefined;
        if (isFunction(listener)) host.addEventListener(listenerEventName(name), listener);
        else bind(read, setter(host, name, false));
      }
      continue;
    }
    const value: unknown = descriptor.value;
    if (prop) {
      if (isFunction(value) && !instance.functionProps.has(name)) write(prop, derive(value));
      else write(prop, { value });
    } else if (isEventProp(name) && isFunction(value)) {
      host.addEventListener(listenerEventName(name), value);
    } else {
      bind(value, setter(host, name, false));
    }
  }
  if (key !== undefined) setter(host, "key", false)(key);
  if (isFunction(props.ref)) instance.ref = props.ref;
  if (owner) {
    instance.owned = true;
    if (!activateInSlot((slotOwner) => instance.activate(slotOwner))) instance.activate(owner);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return host as unknown as ClientNode;
}

/** 名前付きのスロットに置くノードを返す。要素には `slot` 属性を付与し、テキストは `<span slot>` で包む。 */
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
