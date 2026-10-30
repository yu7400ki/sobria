import {
  createLoadingBoundary,
  createMemo,
  createRenderEffect,
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

import { ARIA_ATTRIBUTE, attributeValue, HOST_ATTRIBUTE } from "../shared/attributes.ts";
import {
  createElementComponent,
  elementInfo,
  type Ctx,
  type ElementComponent,
  type ElementOptions,
  fromAttribute,
  propKinds,
  type PropKinds,
  unsupportedFormControls,
} from "../shared/element.ts";
import { checkExposeName } from "../shared/expose-names.ts";
import { reloadEvent } from "../shared/hmr.ts";
import { customEventName, isEventProp } from "../shared/names.ts";
import type { ClientNode } from "../shared/nodes.ts";
import { isFunction } from "../shared/objects.ts";
import { createScope, scopedChild, withScope, type ScopedChild } from "../shared/scope.ts";
import { childKey } from "../shared/transfer-keys.ts";
import {
  applyAttribute,
  asClientNode,
  bind,
  build,
  callRef,
  insert,
  Deferred,
  DeferredRegion,
  attributeSetter,
} from "./dom.ts";
import { formControls, formElementClass } from "./form-element.ts";
import { handleSubmit } from "./form.ts";
import {
  childCursor,
  claimWithin,
  complete,
  createHydration,
  failureOf,
  fail,
  serverStyles,
  shadowCursor,
  takeElement,
  type Cursor,
} from "./hydration.ts";
import { enterRenderScope } from "./shared-context.ts";
import {
  activateInSlot,
  addChild,
  createHostSlots,
  enterHost,
  placeInSlot,
  type HostSlots,
} from "./slots.ts";
import { elementCss } from "./styles.ts";
import { beginTakeover, whenArrived, whenStartable } from "./transfer.ts";

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
  /** 起動した owner。 */
  readonly owner: Owner | null;
}

/** 要素のインスタンスの状態を表す。 */
interface Instance {
  /** props の名前ごとの状態。要素の寿命の間は同じ状態を保持する。 */
  readonly props: ReadonlyMap<string, Prop>;
  /** 要素の設定から求めた、props の分類。 */
  readonly kinds: PropKinds;
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
  /** 値の引き継ぎの段階。 */
  takeover: Takeover;
  /** ホストの `ElementInternals`。 */
  readonly internals: ElementInternals;
}

/**
 * 値の引き継ぎの段階を表す。
 * `waiting` はまだ起動していない段階で、SSR したホストは、最初の起動でだけサーバーから値を引き継ぐ。`from` は、親が作り直した子要素が値を引き継ぐ SSR したホストの ID である。
 * `activation` は、SSR したホストが起動スクリプトに起動の条件を問い合わせていれば `requested`、条件を満たしたと通知されていれば `granted` である。
 * `building` は、引き継いだ値で、SSR の DOM を引き取っているか描画を組み立てている段階で、`done` は、最初の内容を表示できる状態になった後の段階である。
 */
type Takeover =
  | { readonly phase: "waiting"; from?: string; activation?: "requested" | "granted" }
  | { readonly phase: "building" }
  | { readonly phase: "done" };

const instances = new WeakMap<HTMLElement, Instance>();

/** 登録したタグの状態を表す。 */
interface Definition {
  /** 描画に使用する要素の関数。 */
  fn: (props: never, ctx: never) => unknown;
  /** 登録の設定を JSON にした文字列。 */
  readonly signature: string;
  /** 起動しているインスタンス。 */
  readonly shown: Set<Instance>;
}

/** Vite の `import.meta.hot` のうち、要素の登録が呼び出すメンバーを表す。 */
export interface HotContext {
  readonly send: (event: typeof reloadEvent) => void;
}

const definitions = new Map<string, Definition>();

const readSource = (source: Source): unknown => ("read" in source ? source.read() : source.value);

function createProp(source: Source): Prop {
  const [track, trigger] = runWithOwner(null, () =>
    createSignal(undefined, { equals: false, ownedWrite: true }),
  );
  return { source, track, trigger: () => trigger(undefined) };
}

/**
 * `instance` の `prop` に `source` を書き込み、`instance` が起動していれば変化を通知する。
 * 書き込む前と後の source がどちらも値で、`Object.is` で等しければ、何もしない。
 */
function write(instance: Instance, prop: Prop, source: Source): void {
  const before = prop.source;
  if ("value" in before && "value" in source && Object.is(before.value, source.value)) return;
  prop.source = source;
  if (instance.run) prop.trigger();
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

/** サーバーが `internals` の値から出力した、ホスト `host` の ARIA の属性と、その名前を列挙した属性を削除する。 */
function removeServerAria(host: HTMLElement): void {
  const names = host.getAttribute(ARIA_ATTRIBUTE);
  if (names === null) return;
  for (const name of names.split(" ")) host.removeAttribute(name);
  host.removeAttribute(ARIA_ATTRIBUTE);
}

/** 接続していて、最初の内容を表示していれば、まだ呼んでいない `onMount` の関数を呼ぶ。 */
function runMounts(host: HTMLElement, run: Run): void {
  if (!host.isConnected || !run.settled) return;
  const mounts = run.mounts;
  run.mounts = [];
  for (const mount of mounts) mount();
}

/** `fn` を要素として、`tag` の名前で Custom Element に登録し、JSX で使用する要素コンポーネントを返す。登録済みの `tag` を登録するとエラーにする。 */
export function defineElement<P, M extends object = object>(
  tag: string,
  fn: ElementFn<P, M>,
  options: ElementOptions,
): ElementComponent<P, M> {
  return registerElement(tag, fn, options);
}

/**
 * `fn` を要素として、`tag` の名前で Custom Element に登録し、JSX で使用する要素コンポーネントを返す。
 * 登録済みの `tag` をもう一度登録するときは、`hot` が無ければエラーにする。
 * `hot` があり、`options` が前の登録と同じなら、要素の関数を `fn` に置換して、起動しているインスタンスを props の値を引き継いで描画し直す。
 * `options` が前の登録と異なれば、関数を置換せずに、ページの再読み込みを求めるイベントを開発サーバーに送る。
 */
export function registerElement<P, M extends object = object>(
  tag: string,
  fn: ElementFn<P, M>,
  options: ElementOptions,
  hot?: HotContext,
): ElementComponent<P, M> {
  const signature = JSON.stringify(options);
  const defined = definitions.get(tag);
  if (defined) {
    if (!hot) throw new Error(`<${tag}> は既に登録されています。`);
    if (defined.signature !== signature) {
      hot.send(reloadEvent);
    } else {
      defined.fn = fn;
      for (const instance of Array.from(defined.shown)) {
        if (instance.run) instance.activate(instance.run.owner);
      }
    }
    return createElementComponent(tag, fn, options);
  }
  const definition: Definition = { fn, signature, shown: new Set() };
  const kinds = propKinds(options);
  const { events, attributes: propOfAttribute, reflects } = kinds;
  const unsupported = unsupportedFormControls(tag);
  /** 要素の関数に渡す ctx の `form` を返す。 */
  const formOf = options.form ? formControls : () => unsupported;

  /** 要素の関数に渡す props を、インスタンスの props の状態から作成する。 */
  function createProps(host: HTMLElement, instance: Instance): object {
    const props = {};
    for (const [name, prop] of instance.props) {
      const get = () => {
        prop.track();
        return readSource(prop.source);
      };
      if (events.has(name)) {
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
   * 描画の結果は、ノードにしてから 1 つの領域に挿入する。`owner` が `null` なら、その領域を、フォールバックが空の `<Loading>` にする。
   * 起動していれば、前の起動の root を先に破棄する。
   * root を破棄すると、まだ呼んでいない `onMount` の関数を捨て、`instance.run` を `undefined` にする。
   * SSR したホストの最初の起動では、引き継いだ値を memo の最初の値と props にし、Shadow DOM のノードを引き取る。
   * 引き取れなければ、描画を Shadow DOM の外で組み立て直し、最初の内容を表示できる状態になってから、Shadow DOM の中身と置換する。
   */
  function activate(host: HTMLElement, instance: Instance, owner: Owner | null): void {
    const id = transferId(host, instance);
    const ssr = id !== null && id === host.getAttribute(HOST_ATTRIBUTE) && host.shadowRoot !== null;
    start(host, instance, owner, id, id === null ? "direct" : ssr ? "claim" : "build");
  }

  /**
   * `mode` の方法で要素を起動する。`direct` は Shadow DOM に直接描画し、`build` は描画を Shadow DOM の外で組み立てて置き換え、
   * `claim` は SSR した Shadow DOM のノードを引き取る。引き取りに失敗したら、開発時に警告して `build` で起動し直す。
   */
  function start(
    host: HTMLElement,
    instance: Instance,
    owner: Owner | null,
    id: string | null,
    mode: "direct" | "build" | "claim",
  ): void {
    instance.run?.dispose();
    const shadow =
      host.shadowRoot ?? host.attachShadow({ mode: "open", delegatesFocus: options.form === true });
    shadow.addEventListener("submit", handleSubmit);
    const transferred = beginTakeover(id, tag);
    for (const [name, value] of Object.entries(transferred.props)) {
      const prop = instance.props.get(name);
      if (prop) write(instance, prop, { value });
    }
    const scope = createScope(transferred.memo, transferred.values);
    let target: ParentNode = shadow;
    if (mode === "direct") {
      shadow.replaceChildren();
      instance.takeover = { phase: "done" };
    } else {
      if (mode === "build") target = document.createDocumentFragment();
      instance.takeover = { phase: "building" };
    }
    const hydration = mode === "claim" ? createHydration() : undefined;
    runWithOwner(owner, () =>
      createRoot((dispose) => {
        const run: Run = { dispose, mounts: [], settled: false, owner };
        instance.run = run;
        definition.shown.add(instance);
        enterHost(instance.slots);
        enterRenderScope();
        onCleanup(() => {
          instance.run = undefined;
          run.mounts = [];
          definition.shown.delete(instance);
        });
        const sheets: CSSStyleSheet[] = [];
        const ctx: Ctx<M> = {
          host,
          css: elementCss(sheets),
          form: formOf(host, instance.internals),
          internals: instance.internals,
          onMount: (mount) => run.mounts.push(mount),
          expose: (members) => {
            const descriptors = Object.getOwnPropertyDescriptors(members);
            if (import.meta.env?.DEV) {
              for (const name of Object.keys(descriptors)) {
                const error = checkExposeName(name, kinds.names);
                if (error) throw new Error(`<${tag}> ${error}`);
              }
            }
            Object.defineProperties(host, descriptors);
          },
        };
        for (const name of reflects) {
          const prop = instance.props.get(name);
          if (!prop) continue;
          createRenderEffect(
            () => {
              prop.track();
              return readSource(prop.source);
            },
            attributeSetter(host, name),
          );
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const props = createProps(host, instance) as P;
        const render = () => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const current = definition.fn as ElementFn<P, M>;
          const content = untrack(() => withScope(scope, () => current(props, ctx)));
          if (target === shadow) shadow.adoptedStyleSheets = sheets;
          onSettled(() => {
            removeServerAria(host);
            if (hydration) {
              for (const style of serverStyles(shadow)) style.remove();
              instance.takeover = { phase: "done" };
              transferred.finish();
            } else if (target !== shadow) {
              shadow.adoptedStyleSheets = sheets;
              shadow.replaceChildren(target);
              target = shadow;
              instance.takeover = { phase: "done" };
              transferred.finish();
            }
            run.settled = true;
            runMounts(host, run);
          });
          return content;
        };
        const root = new DeferredRegion((at, ns) => {
          if (!owner)
            return createLoadingBoundary(
              () => build(render(), at, ns),
              () => undefined,
            );
          const nodes = build(render(), at, ns);
          return () => nodes;
        }, "keep");
        if (hydration) {
          try {
            claimWithin(shadowCursor(shadow, hydration), (at) => insert(at, root));
          } finally {
            complete(hydration);
          }
        } else {
          insert(target, root);
        }
        if (instance.ref && (!hydration || failureOf(hydration) === undefined)) {
          callRef(instance.ref, host);
        }
      }),
    );
    const failure = hydration && failureOf(hydration);
    if (failure !== undefined) {
      if (import.meta.env?.DEV) {
        console.warn(
          `[sobria] <${tag}> の SSR の DOM を引き取れません。${failure}。Shadow DOM の中身を作り直します。`,
        );
      }
      start(host, instance, owner, id, "build");
    }
  }

  class SobriaElement extends HTMLElement {
    static observedAttributes = [...propOfAttribute.keys()];

    constructor() {
      super();
      const props = new Map<string, Prop>();
      for (const name of kinds.values) {
        const prop = createProp({ value: Object.getOwnPropertyDescriptor(this, name)?.value });
        props.set(name, prop);
        Object.defineProperty(this, name, {
          configurable: true,
          enumerable: true,
          get: () => peek(prop),
          set: (value: unknown) => {
            write(instances.get(this)!, prop, { value });
          },
        });
      }
      const internals = this.attachInternals();
      const instance: Instance = {
        internals,
        props,
        kinds,
        slots: createHostSlots(),
        activate: (owner) => activate(this, instance, owner),
        owned: false,
        takeover: { phase: "waiting" },
      };
      instances.set(this, instance);
    }

    attributeChangedCallback(attribute: string, _old: string | null, value: string | null): void {
      const entry = propOfAttribute.get(attribute);
      if (entry === undefined) return;
      const instance = instances.get(this)!;
      const prop = instance.props.get(entry.name)!;
      if (reflects.has(entry.name) && attributeValue(attribute, peek(prop)) === value) return;
      write(instance, prop, { value: fromAttribute(value, entry.type) });
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

  customElements.define(
    tag,
    options.form
      ? formElementClass(SobriaElement, (host) => instances.get(host)!.internals)
      : SobriaElement,
  );
  definitions.set(tag, definition);
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
 * Shadow DOM の外にある SSR したホストは、起動スクリプトが起動の条件を満たしたと通知するまで起動しない。
 * SSR したホストは、自分の `data-om` のキーと、`@c:キー` の値が指す子要素のホストの `data-om` のキーの値が、すべて届くまで起動しない。
 * 表示されている位置の上に定義済みの要素があれば、そのスロットの `<slot>` の owner の下で起動する。
 * `<slot>` が無ければ、その `<slot>` を作成した時点で、接続していれば起動する。その時点でスロットの位置が変わっていれば、今の位置のスロットに登録し直す。
 * SSR したホストの Shadow DOM の中にあり、そのホストの最初の内容がまだ表示できる状態になっていなければ、起動しない。そのホストが起動するときに、子要素のホストを引き取るか作り直して、子要素も起動する。
 * それ以外の Shadow DOM の中にあるか、上に定義済みの要素が無ければ、最上位の要素として起動する。
 * 前の待機とスロットへの登録は取り消し、新しく待機か登録をしたら、取り消す関数を `instance.cancel` に設定する。
 */
function attach(el: HTMLElement, instance: Instance): void {
  instance.cancel?.();
  instance.cancel = undefined;
  const { takeover } = instance;
  if (
    takeover.phase === "waiting" &&
    takeover.activation !== "granted" &&
    el.hasAttribute(HOST_ATTRIBUTE) &&
    locate(el).kind !== "shadow"
  ) {
    if (takeover.activation === "requested") return;
    takeover.activation = "requested";
    whenStartable(el, () => {
      if (instance.takeover !== takeover) return;
      takeover.activation = "granted";
      if (el.isConnected) attach(el, instance);
    });
    return;
  }
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
  if (position.kind !== "slot") {
    const host = position.kind === "shadow" ? position.host : undefined;
    if (host?.hasAttribute(HOST_ATTRIBUTE) && instanceOf(host)?.takeover.phase !== "done") return;
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
const transferId = (host: HTMLElement, { takeover }: Instance): string | null =>
  takeover.phase === "waiting"
    ? (host.getAttribute(HOST_ATTRIBUTE) ?? takeover.from ?? null)
    : null;

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
 * ホストは、`insert` が挿入するときに作成する。
 */
export function createElementInstance(
  component: ElementComponent<unknown>,
  props: Record<string, unknown>,
  key?: string,
  site?: string,
): ClientNode {
  const child = scopedChild(site);
  return asClientNode(new Deferred((at) => createHost(component, props, key, child, at)));
}

/** `createElementInstance` のホストを作成する。`child` は、描画の範囲で作成した子要素のキーである。 */
function createHost(
  component: ElementComponent<unknown>,
  props: Record<string, unknown>,
  key: string | undefined,
  child: ScopedChild | undefined,
  at: Cursor | undefined,
): HTMLElement {
  const { tag } = component[elementInfo];
  const claimed = at && takeElement(at, tag);
  const host =
    claimed instanceof HTMLElement && instances.has(claimed)
      ? claimed
      : document.createElement(tag);
  if (at && claimed && claimed !== host) fail(at, `<${tag}>の定義`);
  if (at && host !== claimed) return host;
  const instance = instances.get(host)!;
  const transfer: unknown =
    child?.data instanceof Map ? child.data.get(childKey(child.key)) : undefined;
  if (typeof transfer === "string") instance.takeover = { phase: "waiting", from: transfer };
  const owner = getOwner();
  const derive = (read: () => unknown): Source => ({ read: owner ? createMemo(read) : read });
  const assign = (target: ParentNode | Cursor) => {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(props))) {
      if (name === "ref") continue;
      const getter = descriptor.get;
      const read = getter ? () => getter.call(props) as unknown : undefined;
      const value: unknown = read ?? descriptor.value;
      const prop = instance.props.get(name);
      if (instance.kinds.slots.has(name)) {
        placeInSlot(instance.slots, name, (place) => insert(target, value, place));
      } else if (prop) {
        const reactive = read ?? (instance.kinds.isReader(name, value) ? value : undefined);
        write(instance, prop, reactive ? derive(reactive) : { value });
      } else if (read && isEventProp(name)) {
        const listener = untrack(read);
        if (isFunction(listener)) applyAttribute(host, name, listener);
        else bind(read, attributeSetter(host, name));
      } else {
        applyAttribute(host, name, value);
      }
    }
  };
  if (!at) assign(host);
  else if (!claimWithin(childCursor(host, at.hydration), assign)) return host;
  if (key !== undefined) attributeSetter(host, "key")(key);
  if (isFunction(props.ref)) instance.ref = props.ref;
  if (owner) {
    instance.owned = true;
    if (!activateInSlot((slotOwner) => instance.activate(slotOwner))) instance.activate(owner);
  }
  return host;
}
