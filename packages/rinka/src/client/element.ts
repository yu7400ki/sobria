import {
  createLoadingBoundary,
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
  createElementComponent,
  elementInfo,
  type AttributeType,
  type Ctx,
  type ElementComponent,
  type ElementOptions,
} from "../shared/element.ts";
import { checkExposeName } from "../shared/expose-names.ts";
import { customEventName, isEventProp, propToAttribute } from "../shared/names.ts";
import type { ClientNode } from "../shared/nodes.ts";
import { isFunction, isPlainObject } from "../shared/objects.ts";
import { createScope, scopedChild, withScope, type MemoScope } from "../shared/scope.ts";
import { applyAttribute, asClientNode, bind, callRef, insert, setter } from "./dom.ts";
import {
  activateInSlot,
  addChild,
  createHostSlots,
  enterHost,
  placeInSlot,
  type HostSlots,
} from "./slots.ts";
import { seededMemo, transferredValues, whenArrived } from "./transfer.ts";

/** 要素を描画する関数を表す。 */
export type ElementFn<P, M extends object> = (props: P, ctx: Ctx<M>) => unknown;

/** props の値か、値を読み取る関数を表す。読み取る関数は、親が渡した関数か、その関数を親の owner の下で memo にしたものである。 */
type Source = { readonly value: unknown } | { readonly read: () => unknown };

/** props の 1 つを表す。値はすぐに読み取れ、`track` を呼んだ計算は、値を書き込んだ後の flush で再び実行される。 */
interface Prop {
  source: Source;
  readonly track: () => void;
  readonly trigger: () => void;
}

/** 1 回の起動に属する状態を表す。 */
interface Run {
  /** 描画の範囲を破棄する関数。 */
  readonly dispose: () => void;
  /** まだ呼んでいない `onMount` の関数。 */
  mounts: (() => void)[];
  /** 最初の内容を表示したかどうか。 */
  settled: boolean;
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
  /** owner のある場所で作成したかどうか。作成した場所の owner が、起動と破棄を管理する。 */
  owned: boolean;
  /** 起動していれば、その起動の状態。 */
  run?: Run;
  /** 値の到着を待っているか、スロットに登録していれば、待機か登録を取り消す関数。 */
  cancel?: () => void;
  /** 起動した後に呼ぶ、要素への `ref`。 */
  ref?: (host: HTMLElement) => unknown;
  /** 一度起動したかどうか。SSR したホストは、最初の起動でだけ、サーバーから値を引き継ぐ。 */
  started: boolean;
  /** SSR したホストの Shadow DOM の中身を、描画の結果に置き換えたかどうか。 */
  replaced: boolean;
  /** 親が作り直した子要素なら、値を引き継ぐ SSR したホストの ID。 */
  transfer?: string;
}

/** 描画の範囲ごとに、その要素が引き継いだ値を保持する。子要素は、`@c:キー` の値から、値を引き継ぐホストの ID を探す。 */
const scopeValues = new WeakMap<MemoScope, ReadonlyMap<string, unknown>>();

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
function runMounts(host: HTMLElement, run: Run): void {
  if (!host.isConnected || !run.settled) return;
  const mounts = run.mounts;
  run.mounts = [];
  for (const mount of mounts) mount();
}

/** `fn` を要素として、`tag` の名前で Custom Element に登録し、JSX で使用する要素コンポーネントを返す。 */
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
   * `owner` が `null` なら、描画の全体を、フォールバックが空の `<Loading>` で包む。
   * 起動していれば、前の起動の root を先に破棄する。
   * root を破棄すると、まだ呼んでいない `onMount` の関数を捨て、`instance.run` を `undefined` にする。
   * SSR したホストの最初の起動では、引き継いだ値を memo の最初の値と props にし、描画を Shadow DOM の外で組み立てて、
   * 最初の内容を表示できる状態になってから、Shadow DOM の中身と置き換える。
   */
  function activate(host: HTMLElement, instance: Instance, owner: Owner | null): void {
    instance.run?.dispose();
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const id = transferId(host, instance);
    instance.started = true;
    const values = id === null ? new Map<string, unknown>() : transferredValues(id);
    const passed = values.get("@p");
    if (isPlainObject(passed)) {
      for (const [name, value] of Object.entries(passed)) {
        const prop = instance.props.get(name);
        if (prop) write(prop, { value });
      }
    }
    const used = new Set<string>();
    const scope = createScope(
      <T>(key: string, compute: (prev: T | undefined) => T | PromiseLike<T>) => {
        if (!values.has(key)) return createMemo(compute);
        used.add(key);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return seededMemo(values.get(key) as T, compute);
      },
    );
    scopeValues.set(scope, values);
    let target: ParentNode = shadow;
    if (id === null) shadow.replaceChildren();
    else target = document.createDocumentFragment();
    runWithOwner(owner, () =>
      createRoot((dispose) => {
        const run: Run = { dispose, mounts: [], settled: false };
        instance.run = run;
        enterHost(instance.slots);
        onCleanup(() => {
          instance.run = undefined;
          run.mounts = [];
        });
        const ctx: Ctx<M> = {
          host,
          onMount: (mount) => run.mounts.push(mount),
          expose: (members) => {
            const descriptors = Object.getOwnPropertyDescriptors(members);
            if (import.meta.env?.DEV) {
              for (const name of Object.keys(descriptors)) {
                const error = checkExposeName(name, options.props);
                if (error) throw new Error(`<${tag}> ${error}`);
              }
            }
            Object.defineProperties(host, descriptors);
          },
        };
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const props = createProps(host, instance) as P;
        const render = () => {
          const content = untrack(() => withScope(scope, () => fn(props, ctx)));
          onSettled(() => {
            if (target !== shadow) {
              shadow.replaceChildren(target);
              target = shadow;
              instance.replaced = true;
              if (import.meta.env?.DEV) {
                const unused = [...values.keys()].filter(
                  (key) => !key.startsWith("@") && !used.has(key),
                );
                if (unused.length > 0) {
                  console.warn(
                    `[rinka] <${tag}> は、サーバーから引き継いだ memo の値 ${unused.join(", ")} を使用しませんでした。サーバーとクライアントで描画が異なる可能性があります。`,
                  );
                }
              }
            }
            run.settled = true;
            runMounts(host, run);
          });
          return content;
        };
        insert(target, owner ? render() : createLoadingBoundary(render, () => undefined));
        if (instance.ref) callRef(instance.ref, host);
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
        started: false,
        replaced: false,
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
      if (instance.run) runMounts(this, instance.run);
      else if (!instance.owned) {
        queueMicrotask(() => {
          if (!this.isConnected || instance.run) return;
          attach(this, instance);
        });
      }
    }

    disconnectedCallback(): void {
      const instance = instances.get(this)!;
      if (instance.owned) return;
      queueMicrotask(() => {
        if (this.isConnected) return;
        instance.cancel?.();
        instance.cancel = undefined;
        instance.run?.dispose();
      });
    }
  }

  customElements.define(tag, RinkaElement);
  return createElementComponent(tag, fn, options);
}

/**
 * 要素の位置を表す。
 * `slot` は、定義済みの要素 `parent` の、`name` のスロットに配置されていることを表す。
 * `shadow` は、上へ探索する途中で、`host` の Shadow DOM に到達したことを表す。`top` は、上に定義済みの要素が無いことを表す。
 */
type Position =
  | { readonly kind: "slot"; readonly parent: Instance; readonly name: string }
  | { readonly kind: "shadow"; readonly host: Element }
  | { readonly kind: "top" };

/** `el` が表示されている位置から上へ、定義済みの要素か ShadowRoot を探索して、`el` の位置を返す。 */
function locate(el: HTMLElement): Position {
  let child: Element = el;
  for (let node = el.parentNode; node; node = node.parentNode) {
    if (node instanceof ShadowRoot) return { kind: "shadow", host: node.host };
    const parent = instanceOf(node);
    if (parent) return { kind: "slot", parent, name: child.slot };
    if (node instanceof Element) child = node;
  }
  return { kind: "top" };
}

/**
 * owner の無い場所で作成して接続した要素を起動する。
 * SSR したホストは、`data-om` と、起動スクリプトが追加したキーの値がすべて届くまで起動しない。
 * 表示されている位置の上に定義済みの要素があれば、そのスロットの `<slot>` の owner の下で起動する。
 * `<slot>` が無ければ、その `<slot>` を作成した時点で、接続していれば起動する。その時点でスロットの位置が変わっていれば、今の位置のスロットに登録し直す。
 * SSR したホストの Shadow DOM の中にあり、そのホストが Shadow DOM の中身をまだ置き換えていなければ、起動しない。そのホストが中身を置き換えるときに、子要素も作り直す。
 * それ以外の Shadow DOM の中にあるか、上に定義済みの要素が無ければ、最上位の要素として起動する。
 * 前の待機とスロットへの登録は取り消し、新しく待機か登録をしたら、取り消す関数を `instance.cancel` に設定する。
 */
function attach(el: HTMLElement, instance: Instance): void {
  instance.cancel?.();
  instance.cancel = undefined;
  const id = transferId(el, instance);
  if (id !== null) {
    const cancel = whenArrived(el, id, () => {
      instance.cancel = undefined;
      if (el.isConnected) attach(el, instance);
    });
    if (cancel) {
      instance.cancel = cancel;
      return;
    }
  }
  const position = locate(el);
  if (position.kind === "shadow") {
    if (position.host.hasAttribute("data-oh") && !instanceOf(position.host)?.replaced) return;
    instance.activate(null);
    return;
  }
  if (position.kind === "top") {
    instance.activate(null);
    return;
  }
  instance.cancel = addChild(position.parent.slots, position.name, (owner) => {
    if (!el.isConnected) return;
    const current = locate(el);
    if (
      current.kind === "slot" &&
      current.parent === position.parent &&
      current.name === position.name
    ) {
      instance.activate(owner);
    } else {
      attach(el, instance);
    }
  });
}

/** 要素がまだ起動しておらず、SSR したホストか、親が作り直した子要素なら、値を引き継ぐホストの ID を返す。 */
const transferId = (host: HTMLElement, instance: Instance): string | null =>
  instance.started ? null : (host.getAttribute("data-oh") ?? instance.transfer ?? null);

const instanceOf = (node: Node): Instance | undefined =>
  node instanceof HTMLElement ? instances.get(node) : undefined;

/**
 * JSX の中で、要素のインスタンスを作成する。
 * `options.props` に名前がある値は props に設定し、関数の値（関数の props を除く）と getter は、owner があれば親の owner の memo にする。
 * それ以外の値と `key` はホストの属性にし、props に無い `onX` の関数はホストのリスナーにする。
 * `children` とスロットの props の内容は Light DOM に配置し、その中の子要素は、ホストがそのスロットの `<slot>` を作成した後に起動する。
 * スロットに配置する内容でなければ、owner があればその owner の下で同期的に起動する。owner が無ければ、接続した後に、表示されている位置から探索した定義済みの要素の下で起動する。見つからなければ、最上位の要素として起動する。
 * 要素への `ref` は、起動した後に呼ぶ。
 * 引き継いだ値のある要素の描画で、呼び出し箇所 `site` を指定して作成した子要素は、同じキーの SSR した子要素の値を引き継ぐ。
 */
export function createElementInstance(
  component: ElementComponent<unknown>,
  props: Record<string, unknown>,
  key?: string,
  site?: string,
): ClientNode {
  const host = document.createElement(component[elementInfo].tag);
  const instance = instances.get(host)!;
  const child = scopedChild(site);
  const transfer = child && scopeValues.get(child.scope)?.get(`@c:${child.key}`);
  if (typeof transfer === "string") instance.transfer = transfer;
  const owner = getOwner();
  const derive = (read: () => unknown): Source => ({ read: owner ? createMemo(read) : read });
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(props))) {
    if (name === "ref") continue;
    const getter = descriptor.get;
    const read = getter ? () => getter.call(props) as unknown : undefined;
    const value: unknown = read ?? descriptor.value;
    const prop = instance.props.get(name);
    if (instance.slotNames.has(name)) {
      placeInSlot(instance.slots, name, (place) => insert(host, value, place));
    } else if (prop) {
      const reactive =
        read ?? (isFunction(value) && !instance.functionProps.has(name) ? value : undefined);
      write(prop, reactive ? derive(reactive) : { value });
    } else if (read && isEventProp(name)) {
      const listener = untrack(read);
      if (isFunction(listener)) applyAttribute(host, name, listener);
      else bind(read, setter(host, name, false));
    } else {
      applyAttribute(host, name, value);
    }
  }
  if (key !== undefined) setter(host, "key", false)(key);
  if (isFunction(props.ref)) instance.ref = props.ref;
  if (owner) {
    instance.owned = true;
    if (!activateInSlot((slotOwner) => instance.activate(slotOwner))) instance.activate(owner);
  }
  return asClientNode(host);
}
