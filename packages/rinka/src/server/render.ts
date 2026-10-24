import {
  createMemo,
  createRoot,
  getOwner,
  NotReadyError,
  resolve,
  runWithOwner,
  untrack,
  type Owner,
} from "@solidjs/signals";

import {
  attributeValue,
  ARIA_ATTRIBUTE,
  AWAITED_ATTRIBUTE,
  BOUNDARY_ATTRIBUTE,
  BOUNDARY_END,
  BOUNDARY_CONTENT_ATTRIBUTE,
  FORM_VALUE_ATTRIBUTE,
  HOST_ATTRIBUTE,
  LOAD_ATTRIBUTE,
  PATCH_ATTRIBUTE,
  tagAttributeName,
} from "../shared/attributes.ts";
import {
  elementInfo,
  isElementComponent,
  propKinds,
  type Ctx,
  type ElementComponent,
  unsupportedFormControls,
} from "../shared/element.ts";
import { headKey } from "../shared/head.ts";
import { isEventProp, propToAttribute, reservedProp } from "../shared/names.ts";
import type { NavigationProps } from "../shared/navigation.ts";
import { isFunction } from "../shared/objects.ts";
import type { ListedElement, SwapSpec } from "../shared/receiver.ts";
import type { RefreshJson, RefreshValues } from "../shared/refresh.ts";
import { createScope, withScope, type ScopedChild } from "../shared/scope.ts";
import { BOUNDARIES_KEY, childKey, PROPS_KEY, REFRESH_PROPS_KEY } from "../shared/transfer-keys.ts";
import { checkSerializable, formProps } from "../shared/wire.ts";
import { ariaAttributes } from "./aria.ts";
import {
  bootstrap,
  dataScript,
  listScript,
  loadAttributeValue,
  noValue,
  swapScript,
} from "./bootstrap.ts";
import {
  attributesText,
  documentTags,
  headlessParents,
  headTags,
  mergeByName,
  rootAttributesOf,
  warnsOutOfHead,
  type Attributes,
  type DocumentParts,
  type HeadOutput,
  type Hoisted,
} from "./document-head.ts";
import { classify } from "./errors.ts";
import { HostRecord, hostIds } from "./host-record.ts";
import { attribute, checkAttributeName, escapeAttribute, escapeText } from "./html.ts";
import { Labels } from "./labels.ts";
import {
  mergeDelivered,
  Out,
  resolvable,
  type DeferredFlush,
  type Delivered,
  type Flush,
  type ShellFlush,
} from "./out.ts";
import { scriptJson } from "./script.ts";
import { elementCss, propertiesStyle, type SheetInfo } from "./styles.ts";
import { asNode, type ErroredNode, type Node } from "./tree.ts";
import { toScript } from "./wire.ts";

/**
 * 描画の種類を表す。`fragment` は `renderToString` の描画で、文書の骨組みに何も移動しない。
 * `document` は文書を出力する描画で、`write` は出力する文字列を受け取る。`blocking` なら、すべての境界を待って、フォールバックと差し替えを出力しない。
 * `refresh` は `refreshPage()` の描き直しで、要素を実行せずに、Shadow DOM の中身を持たないホストを出力する。
 * `fragment` と `refresh` は、すべての境界を待ち、文字列を書き込まない。
 */
export type Target =
  | { readonly kind: "fragment" }
  | {
      readonly kind: "document";
      readonly write: (text: string) => void;
      readonly blocking: boolean;
    }
  | { readonly kind: "refresh" };

/** 境界の差し替えを表す。 */
interface Patch {
  readonly id: string;
  /** 目印を含む Shadow DOM のホストを、外側から順に列挙する。 */
  readonly path: readonly HostRecord[];
  readonly html: Promise<string>;
  /** 差し替えの中身を出力する位置である。 */
  readonly out: Out;
}

/** サーバーの描画で、`ctx.host` の代わりに渡す値である。プロパティを参照すると、エラーを投げる。 */
const serverHost = new Proxy(
  {},
  {
    get() {
      throw new Error(
        "サーバーで描画している間は、ctx.host を使用できません。onMount か effect の中で使用してください。",
      );
    },
  },
);

/**
 * 出力の単位を表す。文字列、穴、投げられた値、`<Loading>` の位置、`<Errored>` の領域、スロットの内容、要素のホストのいずれかである。
 * 穴は、描画した時点では内容が決まらず、値が解決してから内容が決まる位置である。
 * 後送りの境界は、シェルにはフォールバックを目印で囲んで出力し、中身はシェルの後に出力して、起動スクリプトが目印の間の内容を差し替える。
 */
type Chunk = string | Hole | Fail | Mark | ErroredRegion | Slotted | Host;

/** 穴を表す。`hole` は、内容が決まると出力の単位の列に解決する。 */
interface Hole {
  readonly kind: "hole";
  readonly hole: Promise<Chunk[]>;
}

/** 描画の途中で同期的に投げられた値を表す。文字列にする時点で、保持している値を投げる。 */
interface Fail {
  readonly kind: "fail";
  readonly fail: unknown;
}

/** `<Loading>` の位置を表す。中身を埋め込むか、フォールバックを出力して後送りにするかは、文字列にする時点で決定する。 */
interface Mark {
  readonly kind: "mark";
  readonly mark: Boundary;
  readonly fallback: () => Chunk[];
}

/** `<Errored>` の領域を表す。中身が失敗すると、`node.fallback` が返した内容を出力する。 */
interface ErroredRegion {
  readonly kind: "errored";
  readonly errored: { readonly chunks: Chunk[]; readonly node: ErroredNode; readonly ctx: WalkCtx };
}

/**
 * 要素の Light DOM のうち、Shadow DOM の `<Loading>` の中にある `<slot>` に配置する内容を表す。
 * 境界を後送りにし、内容に穴があれば、目印を出力して、内容の全体を境界の差し替えとして後から出力する。
 */
interface Slotted {
  readonly kind: "slotted";
  readonly slotted: {
    readonly boundary: Boundary;
    readonly chunks: Chunk[];
    /** 目印を含む Shadow DOM のホストを、外側から順に列挙する。 */
    readonly path: readonly HostRecord[];
  };
}

/**
 * 要素のホストの属性を表す。`transfer` は、属性にできない props の値を、props の名前ごとに保持する。
 * `current` は、描き直しで、ページにある要素に設定する props の値を、props の名前ごとに保持する。
 */
interface HostAttributes {
  readonly text: string;
  /** `text` に出力した属性の名前である。 */
  readonly names: ReadonlySet<string>;
  readonly transfer: Readonly<Record<string, unknown>> | undefined;
  readonly current: Readonly<Record<string, unknown>>;
}

/** 要素のホストを表す。開始タグは、`chunks` を文字列にした後で、待つ境界を決定してから出力する。 */
interface Host {
  readonly kind: "host";
  readonly host: {
    readonly attributes: HostAttributes | Promise<HostAttributes>;
    /** 開始タグを返し、ホストの値を `at` の位置で渡す。 */
    readonly open: (attributes: HostAttributes, at: Out) => string;
    readonly chunks: Chunk[];
    /** 要素を作成したホストに、開始タグの後で `@c:キー` を送るスクリプトである。 */
    readonly announce: string | undefined;
    /** サーバーコンポーネントが直接使用した、配信の情報を持つ要素なら、起動スクリプトに伝える内容を持つ。 */
    readonly delivered: Delivered | undefined;
    /** 要素の関数が ctx の `css` に渡したシートの情報である。 */
    readonly sheets: readonly SheetInfo[];
  };
}

/** `<Loading>` の境界と、シェルを表す。 */
interface Boundary {
  readonly id: string;
  /** 目印を含む Shadow DOM のホストを、外側から順に列挙する。 */
  readonly path: readonly HostRecord[];
  /** 境界の領域に出力する単位の列を表す。 */
  readonly region: Chunk[];
  /** 境界の中の `<slot>` に配置するスロットの内容を表す。内容に穴があれば、境界は保留中になる。 */
  readonly slotted: Chunk[][];
  readonly patches: Patch[];
  /** 境界を後送りにしたときに、中身を送るチャンクを表す。 */
  flush?: DeferredFlush;
}

/** 描画している位置の状態を表す。 */
interface WalkCtx {
  /** 要素の描画の範囲を表す owner である。要素の外では `null` である。 */
  readonly owner: Owner | null;
  /** この位置を含む Shadow DOM のホストを、外側から順に列挙する。 */
  readonly path: readonly HostRecord[];
  /** この位置を囲む境界を表す。 */
  readonly boundary: Boundary;
  /** 要素の Shadow DOM の中なら、`<slot>` の名前ごとに、その `<slot>` を囲む境界を記録する。 */
  readonly slots: Map<string, Boundary> | undefined;
  /** 名前付きのスロットに配置する内容のうち、最上位のノードを描画しているときは、そのスロットの名前を表す。 */
  readonly slot: string | undefined;
  /** この位置を記述したルートのファイルの深さである。ルートのファイルの外では 0 である。 */
  readonly depth: number;
  /** この位置のタグを `<head>` に移動するかどうかを表す。 */
  readonly head: HeadPlacement;
  /** 同じ tree の外側にある `<fieldset disabled>` で無効になるかどうかを返す。値が未解決なら `NotReadyError` を投げる。 */
  readonly disabled: () => boolean;
  /** `<fieldset>` の子なら、その `<fieldset>` の子の `<legend>` を表す。 */
  readonly legend: Legend | undefined;
  /** `<Loading>` のフォールバックの中で、フォールバックと同じ tree にあれば `true` である。 */
  readonly fallback: boolean;
}

/** SSR するフォームの部品のホストの `name` と `disabled` を返す関数を表す。 */
interface FormProps {
  /** ホストの `name` を返す。 */
  readonly name: () => unknown;
  /** ホストの `disabled` か、同じ tree の外側にある `<fieldset disabled>` で無効になるかどうかを返す。値が未解決なら `NotReadyError` を投げる。 */
  readonly disabled: () => boolean;
}

/**
 * `<fieldset>` の子の `<legend>` を表す。`taken` は、最初の `<legend>` を描画したかどうかで、
 * `outer` は、その `<fieldset>` の外側の `<fieldset disabled>` で無効になるかどうかを返す関数である。最初の `<legend>` の中は、`outer` でだけ無効になる。
 * `taken` は、`<fieldset>` の子を walk する間に書き換えるので、穴の中の `<legend>` は、穴の外の `<legend>` より後に描画したものとして扱う。
 */
interface Legend {
  taken: boolean;
  readonly outer: () => boolean;
}

/** `disabled` の属性の値 `value` が、無効であることを表すかどうかを返す。 */
const disables = (value: unknown): boolean => attributeValue("disabled", value) !== null;

/** 常に無効でないことを返す。 */
const notDisabled = (): boolean => false;

/**
 * フォームの部品 `<tag>` の Light DOM の先頭に出力する hidden input を返す。ホストの `name` が文字列で、`form.value` の値 `value` が文字列のときだけ出力する。
 * `name` があり、`value` が文字列、`null`、`undefined` のどれでもなければ、開発時に警告する。
 */
function hiddenInput(tag: string, name: unknown, value: unknown, disabled: boolean): string {
  if (typeof name !== "string") return "";
  if (typeof value === "string") {
    return `<input type="hidden"${attribute("name", name)}${attribute("value", value)}${attribute(FORM_VALUE_ATTRIBUTE, true)}${attribute("disabled", disabled)}>`;
  }
  if (value !== null && value !== undefined && import.meta.env?.DEV) {
    console.warn(
      `[rinka] <${tag}> の form.value に渡した関数が文字列以外の値を返したので、JS が届く前にフォームを送信すると、この部品の値は送信されません。`,
    );
  }
  return "";
}

/**
 * タグを `<head>` に移動するかどうかを表す。
 * `auto` は `<title>`、`<meta>`、`<link>` を移動し、`all` はシェルの `<head>` の子として、すべてのタグを移動し、`none` は `<svg>` か `<noscript>` の配下と、`<head>` に移動するタグの子孫として、どのタグも移動しない。
 * `fallback` は `<Loading>` のフォールバックの中として、どのタグも移動せずに、`<Loading>` の内側と同じく警告する。
 * `element` は要素の Shadow DOM の中身と、要素に渡した Light DOM の子として、どのタグも移動せずに、要素の中として警告する。
 */
type HeadPlacement = "auto" | "all" | "none" | "fallback" | "element";

/**
 * 文書を出力する描画で、描画している位置を表す。`shell` は、文書の骨組みに移動できる位置である。
 * `shell` 以外の値は、移動できない理由を表す。`loading` は `<Loading>` の内側を表し、`none`、`element`、`fallback` は同じ名前の `HeadPlacement` の位置を表す。
 */
type Position = Exclude<HeadPlacement, "auto" | "all"> | "shell" | "loading";

/** 移動できない位置ごとの、開発時の警告に表示する位置の説明である。 */
const positionNames = {
  none: " <head> に移動しない位置（<svg> や <noscript> の配下、<head> に移動するタグの中）",
  element: "要素の中",
  fallback: " <Loading> のフォールバックの中",
  loading: " <Loading> の内側",
} as const satisfies Record<Exclude<Position, "shell">, string>;

/** `placement` の位置にある `tag` の子の `HeadPlacement` を返す。 */
function childPlacement(tag: string, placement: HeadPlacement): HeadPlacement {
  if (headlessParents.has(tag) || placement === "none") return "none";
  return placement === "all" ? "auto" : placement;
}

const isNodeList = (node: Node): node is readonly Node[] => Array.isArray(node);

const voidTags: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/** 目印の開始と終了の HTML を返す。 */
const marker = (id: string, inner = ""): string =>
  `<template ${BOUNDARY_ATTRIBUTE}="${id}"></template>${inner}<!--${BOUNDARY_END}${id}-->`;

/**
 * 出力の単位の列に、穴があるかどうかを返す。`<Errored>` の領域と要素のホストの中は調べ、`<Loading>` の中とスロットの内容の中は調べない。属性が未解決のホストは、穴として扱う。
 */
function hasHole(chunks: readonly Chunk[]): boolean {
  return chunks.some((chunk) => {
    if (typeof chunk === "string") return false;
    switch (chunk.kind) {
      case "hole":
        return true;
      case "errored":
        return hasHole(chunk.errored.chunks);
      case "host":
        return chunk.host.attributes instanceof Promise || hasHole(chunk.host.chunks);
      case "fail":
      case "mark":
      case "slotted":
        return false;
    }
  });
}

/** `ctx` の位置の tree scope を、最も内側の Shadow DOM のホストの ID か、文書を表す空の文字列で返す。 */
const scopeOf = (ctx: WalkCtx): string => ctx.path.at(-1)?.id ?? "";

/** 起動スクリプトに伝える要素の一覧の項目にする。 */
const listed = ({ tag, delivery }: Delivered): ListedElement => [
  tag,
  delivery.module,
  delivery.load,
];

/** `elements` を起動スクリプトに伝えるスクリプトを返す。要素が無ければ空の文字列を返す。 */
const announceScript = (elements: readonly Delivered[]): string => listScript(elements.map(listed));

/** `elements` のうち、すぐ起動するインスタンスがある要素のモジュールと、そのチャンクの `modulepreload` を、同じ URL を 1 回だけ含めて返す。 */
const preloadLinks = (elements: readonly Delivered[]): string => {
  const urls = new Set(
    elements
      .filter((delivered) => delivered.immediate)
      .flatMap(({ delivery }) => [delivery.module].concat(delivery.chunks ?? [])),
  );
  return [...urls]
    .map((url) => `<link rel="modulepreload" href="${escapeAttribute(url)}">`)
    .join("");
};

/** サーバーで木を描画する。 */
export class Renderer<K extends Target["kind"] = Target["kind"]> {
  /** 描画の種類を、型の上で区別する。 */
  declare private readonly kind: K;
  private seq = 0;
  private readonly disposers: (() => void)[] = [];
  /** シェルの後に後送りの境界を出力する処理のうち、終わっていないものを保持する。 */
  private readonly pending = new Set<Promise<void>>();
  /** この描画で作成したすべてのホストを保持する。 */
  private readonly hosts = new Set<HostRecord>();
  /** ホストに値を送る処理のうち、終わっていないものを保持する。 */
  private readonly values = new Set<Promise<void>>();
  /** 要素を描画したか、`<Loading>` の中身を後送りにしたときに真になる。真になったページにだけ、起動スクリプトを出力する。 */
  private interactive = false;
  /** `noindex` の `<meta>` を出力したことを表す。 */
  private noindexSent = false;
  /** シェルを表す境界である。 */
  private readonly root = this.newBoundary("", []);
  /** シェルの最も外側の位置である。 */
  private readonly shellOut = Out.of({
    ...resolvable(),
    kind: "shell",
  } satisfies ShellFlush);
  /** 起動スクリプトに伝えた要素のタグ名を保持する。 */
  private readonly announcedTags = new Set<string>();
  /** シェルの中の `<Errored>` が受け止めたときのステータスのうち、最も大きいものを表す。 */
  private caught = 200;
  /** 文書の骨組みに移動するものの目印に含める、描画ごとの値である。 */
  private readonly nonce = crypto.randomUUID();
  /** `@property` の規則を出力したシートの URL である。 */
  private readonly sentSheets = new Set<string>();
  /** `<label for>` の補完の目印を作成し、置換する。 */
  private readonly labels = new Labels(this.nonce);
  /** 文書の骨組みに移動するものを、目印の番号ごとに保持する。 */
  private readonly hoisted = new Map<number, Hoisted>();

  /** ホストの ID の接頭辞である。 */
  private readonly hostPrefix: string;
  /** すべての境界を待って、フォールバックと差し替えを出力しないかどうかである。 */
  private readonly blocking: boolean;
  /** 文字列を出力する。文書を出力しない描画では、エラーを投げる。 */
  private readonly write: (text: string) => void;
  /** シェルの中かつ要素の外の `<title>`、`<meta>`、`<link>` と `<head>` の子を `<head>` に移動し、`<html>` と `<body>` の属性を文書の開始タグに移動するかどうかである。 */
  private readonly hoists: boolean;
  /** 要素を実行して、Shadow DOM の中身を出力するかどうかである。 */
  private readonly runsElements: boolean;

  /** `given` の種類の描画を作成する。 */
  constructor(given: Extract<Target, { readonly kind: K }>) {
    const target: Target = given;
    this.hoists = target.kind !== "fragment";
    this.runsElements = target.kind !== "refresh";
    this.hostPrefix = target.kind === "refresh" ? `r${this.nonce.slice(0, 8)}-` : "";
    this.blocking = target.kind !== "document" || target.blocking;
    this.write =
      target.kind === "document"
        ? target.write
        : () => {
            throw new Error(`${target.kind} の描画は、文字列を書き込みません。`);
          };
  }

  /** シェルの中の `<Errored>` が受け止めたときのステータスのうち、最も大きいものを返す。受け止めていなければ 200 を返す。 */
  get status(): number {
    return this.caught;
  }

  private newBoundary(id: string, path: readonly HostRecord[]): Boundary {
    return { id, path, region: [], slotted: [], patches: [] };
  }

  private chunks(node: Node, ctx: WalkCtx): Chunk[] {
    const out: Chunk[] = [];
    this.walk(node, ctx, out);
    return out;
  }

  private walk(node: Node, ctx: WalkCtx, out: Chunk[]): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") {
      const text = escapeText(String(node));
      out.push(
        ctx.slot === undefined ? text : `<span slot="${escapeAttribute(ctx.slot)}">${text}</span>`,
      );
      return;
    }
    if (isNodeList(node)) {
      for (const item of node) this.walk(item, ctx, out);
      return;
    }
    if (typeof node === "function") {
      this.thunk(node, ctx, out);
      return;
    }
    switch (node.kind) {
      case "tag":
        this.tag(node.tag, node.props, node.key, ctx, out);
        return;
      case "loading": {
        const boundary = this.newBoundary(`b${++this.seq}`, ctx.path);
        this.walk(node.children, { ...ctx, boundary }, boundary.region);
        out.push({
          kind: "mark",
          mark: boundary,
          fallback: () =>
            this.chunks(node.fallback, {
              ...ctx,
              head: ctx.head === "none" || ctx.head === "element" ? ctx.head : "fallback",
              fallback: true,
            }),
        });
        return;
      }
      case "errored":
        this.errored(node, ctx, out);
        return;
      case "depth":
        this.walk(asNode(node.children), { ...ctx, depth: node.depth }, out);
        return;
      case "navigation":
        this.navigation(node.props, ctx, out);
        return;
      case "component": {
        if (isElementComponent(node.fn)) {
          this.element(node.fn, node.props, node.key, ctx, out, node.child);
          return;
        }
        const result = node.fn(node.props);
        if (result instanceof Promise) {
          out.push(this.hole(result.then((value) => this.chunks(asNode(value), ctx))));
        } else {
          this.walk(asNode(result), ctx, out);
        }
      }
    }
  }

  /** 関数を呼び出した値を描画する。関数が未解決の値を参照すると、値が解決してから描画する穴にする。 */
  private thunk(fn: () => Node, ctx: WalkCtx, out: Chunk[]): void {
    const value = this.settle(ctx, fn);
    if (value instanceof Promise) {
      out.push(this.hole(value.then((resolved) => this.chunks(resolved, ctx))));
    } else {
      this.walk(value, ctx, out);
    }
  }

  /** `promise` の穴を作成する。描画を中断して穴を捨てたときも、`promise` の reject を処理する。 */
  private hole(promise: Promise<Chunk[]>): Hole {
    promise.catch(() => {});
    return { kind: "hole", hole: promise };
  }

  /**
   * `<label>` の `props` の `for` が文字列なら、`<label>` の `id` と目印を返す。`id` が無ければ、`rinka-l` と連番の `id` を使用する。
   * `for` か `id` の値が未解決なら、`undefined` を返す。
   */
  private labelOf(
    props: Record<string, unknown>,
    ctx: WalkCtx,
  ): { readonly id: string; readonly mark: string } | undefined {
    const target = this.settle(ctx, (tracked) => this.value(props.for, ctx, tracked));
    const given = this.settle(ctx, (tracked) => this.value(props.id, ctx, tracked));
    if (typeof target !== "string" || given instanceof Promise) return undefined;
    return this.labels.label(scopeOf(ctx), target, given);
  }

  /** `props` の値を返す。関数は、追跡せずに呼び出して、戻り値を返す。`tracked` なら、追跡して呼び出す。 */
  private value(raw: unknown, ctx: WalkCtx, tracked: boolean): unknown {
    if (!isFunction(raw)) return raw;
    return tracked ? raw() : runWithOwner(ctx.owner, () => untrack(raw));
  }

  /** `compute` を追跡せずに呼び出した値を返す。未解決の値を参照したときは、追跡して呼び出した値が解決する Promise を返す。 */
  private settle<T>(ctx: WalkCtx, compute: (tracked: boolean) => T): T | Promise<T> {
    try {
      return runWithOwner(ctx.owner, () => untrack(() => compute(false)));
    } catch (error) {
      if (!(error instanceof NotReadyError)) throw error;
      const settled = runWithOwner(ctx.owner, () => resolve(() => compute(true)));
      settled.catch(() => {});
      return settled;
    }
  }

  /** 確定した値か、解決する Promise の `value` を、`text` で文字列にした出力の単位にする。 */
  private chunkOf<T>(value: T | Promise<T>, text: (value: T) => string): Chunk {
    return value instanceof Promise
      ? this.hole(value.then((settled) => [text(settled)]))
      : text(value);
  }

  private tag(
    tag: string,
    props: Record<string, unknown>,
    key: string | undefined,
    ctx: WalkCtx,
    out: Chunk[],
  ): void {
    const role = this.hoists ? documentTags.get(tag) : undefined;
    const position = this.position(ctx);
    if (role === "html" || role === "body" || role === "transparent") {
      if (position !== "shell") {
        this.warnOutside(tag, position, `文書の <${tag}> に反映せずに、子だけを出力します`);
        this.walk(asNode(props.children), ctx, out);
        return;
      }
      if (role === "transparent") {
        this.walk(asNode(props.children), { ...ctx, head: "all" }, out);
        return;
      }
      const id = ++this.seq;
      this.hoisted.set(id, {
        kind: role,
        values: this.rootAttributes(props, ctx),
        depth: ctx.depth,
      });
      out.push(this.marker(id, ""), this.marker(id, "/"));
      this.walk(asNode(props.children), ctx, out);
      return;
    }
    const movable =
      role === "head" && (tag === "title" || attributeValue("itemprop", props.itemprop) === null);
    if (movable && position !== "shell" && position !== "none" && warnsOutOfHead(tag, props)) {
      this.warnOutside(tag, position, "<head> に移動せずに、記述した位置に出力します");
    }
    const hoist = position === "shell" && (ctx.head === "all" || movable);
    if (!hoist) {
      this.nativeTag(tag, props, key, ctx, out);
      return;
    }
    const id = ++this.seq;
    const headTagKey = this.settle(ctx, (tracked) =>
      headKey(tag, (name) => this.value(props[name], ctx, tracked)),
    );
    this.hoisted.set(id, { kind: "head", key: headTagKey, depth: ctx.depth });
    out.push(this.marker(id, ""));
    this.nativeTag(tag, props, key, { ...ctx, head: "none" }, out);
    out.push(this.marker(id, "/"));
  }

  /** 文書を出力する描画で、`<title>` を `<head>` に移動する位置の `<Navigation>` の props を、深さとともに記録する。 */
  private navigation(props: NavigationProps, ctx: WalkCtx, out: Chunk[]): void {
    if (!this.hoists) return;
    const position = this.position(ctx);
    if (position !== "shell") {
      this.warnOutside("Navigation", position, "反映しません");
      return;
    }
    const values = new Map<keyof NavigationProps, NavigationProps[keyof NavigationProps]>();
    if (props.transitions !== undefined) values.set("transitions", props.transitions);
    if (props.prefetch !== undefined) values.set("prefetch", props.prefetch);
    const id = ++this.seq;
    this.hoisted.set(id, { kind: "navigation", values, depth: ctx.depth });
    out.push(this.marker(id, ""), this.marker(id, "/"));
  }

  /** `ctx` の位置を返す。 */
  private position(ctx: WalkCtx): Position {
    if (ctx.head !== "auto" && ctx.head !== "all") return ctx.head;
    return ctx.boundary === this.root ? "shell" : "loading";
  }

  /** `position` にある `tag` を、開発時に、位置の説明と、`action` に記述した扱いとともに警告する。 */
  private warnOutside(tag: string, position: Exclude<Position, "shell">, action: string): void {
    if (!import.meta.env?.DEV) return;
    console.warn(`[rinka] <${tag}> は${positionNames[position]}にあるので、${action}。`);
  }

  /** `<html>` か `<body>` の `props` を、属性の名前ごとの値にする。未解決の値を読む属性は除く。 */
  private rootAttributes(props: Record<string, unknown>, ctx: WalkCtx): Attributes {
    const attributes = new Map<string, string | null>();
    for (const [name, raw] of Object.entries(props)) {
      if (name === "children" || name === "ref" || name === "slot") continue;
      if (isEventProp(name) && isFunction(raw)) continue;
      let value: unknown;
      try {
        value = this.value(raw, ctx, false);
      } catch (error) {
        if (error instanceof NotReadyError) continue;
        throw error;
      }
      checkAttributeName(name);
      attributes.set(name, attributeValue(name, value));
    }
    return attributes;
  }

  /** 文書の骨組みに移動するものの前（`end` が空）と後（`end` が `/`）に置く目印である。 */
  private marker(id: number, end: "" | "/"): string {
    return `<!--${this.nonce}:${id}${end}-->`;
  }

  private nativeTag(
    tag: string,
    props: Record<string, unknown>,
    key: string | undefined,
    ctx: WalkCtx,
    out: Chunk[],
  ): void {
    const label =
      tag === "label" && this.runsElements && !ctx.fallback ? this.labelOf(props, ctx) : undefined;
    const attributesOf =
      tag === "form" ? formProps(props) : label ? { ...props, id: label.id } : props;
    if (ctx.owner === null) warnHandlers(tag, props);
    const openTag = (tracked: boolean): string => {
      let attributes = "";
      for (const [name, raw] of Object.entries(attributesOf)) {
        if (name === "children" || name === "ref") continue;
        if (name === "slot" && ctx.slot !== undefined) continue;
        if (isEventProp(name) && isFunction(raw)) continue;
        attributes += attribute(name, this.value(raw, ctx, tracked));
      }
      if (key !== undefined) attributes += attribute(tagAttributeName("key"), key);
      if (ctx.slot !== undefined) attributes += attribute("slot", ctx.slot);
      return `<${tag}${attributes}>`;
    };
    if (tag === "slot") {
      const name = this.value(props.name, ctx, false);
      ctx.slots?.set(typeof name === "string" ? name : "", ctx.boundary);
    }
    const open = this.settle(ctx, openTag);
    out.push(this.chunkOf(open, (text) => text));
    if (label) out.push(label.mark);
    if (voidTags.has(tag)) return;
    const { legend, disabled: outer } = ctx;
    let disabled = outer;
    if (tag === "legend" && legend && !legend.taken) {
      legend.taken = true;
      disabled = legend.outer;
    }
    if (tag === "fieldset")
      disabled = () => outer() || disables(this.value(props.disabled, ctx, true));
    this.walk(
      asNode(props.children),
      {
        ...ctx,
        head: childPlacement(tag, ctx.head),
        slot: undefined,
        disabled,
        legend: tag === "fieldset" ? { taken: false, outer } : undefined,
      },
      out,
    );
    out.push(`</${tag}>`);
  }

  private errored(node: ErroredNode, ctx: WalkCtx, out: Chunk[]): void {
    let chunks: Chunk[] = [];
    try {
      this.walk(node.children, ctx, chunks);
    } catch (error) {
      chunks = [{ kind: "fail", fail: error }];
    }
    out.push({ kind: "errored", errored: { chunks, node, ctx } });
  }

  /**
   * 要素のホストを出力し、Shadow DOM の中身を DSD として出力してから、Light DOM の子を出力する。描き直しでは、Shadow DOM の中身を出力しない。
   * `child` があれば、要素を作成した描画の範囲のホストに、`@c:キー` でこの要素のホストの ID を送る。
   */
  private element(
    component: ElementComponent<unknown>,
    props: Record<string, unknown>,
    key: string | undefined,
    ctx: WalkCtx,
    out: Chunk[],
    child?: ScopedChild,
  ): void {
    this.interactive = true;
    const { tag, options, delivery } = component[elementInfo];
    const load = loadAttributeValue(props);
    const delivered: Delivered | undefined =
      delivery && ctx.owner === null
        ? { tag, delivery, immediate: (load ?? delivery.load) === "load" }
        : undefined;
    const id = `${this.hostPrefix}h${++this.seq}`;
    const record = new HostRecord(id, tag);
    this.hosts.add(record);
    let announce: string | undefined;
    if (child?.data instanceof HostRecord && this.hosts.has(child.data)) {
      const creator = child.data;
      const mapKey = childKey(child.key);
      if (creator.listChild(mapKey)) {
        this.send(creator, mapKey, Promise.resolve(scriptJson(id)));
      } else {
        announce = dataScript(creator.id, mapKey, scriptJson(id));
      }
    }
    const { slots: slotNames, functions: functionProps } = propKinds(options);
    const descriptors = Object.getOwnPropertyDescriptors(props);
    const read = (name: string): unknown => {
      const descriptor = descriptors[name];
      const getter = descriptor?.get;
      return getter ? (getter.call(props) as unknown) : descriptor?.value;
    };
    /** 要素の関数に渡す値を返す。関数の props でない props に渡した関数は、呼び出した値にする。 */
    const propValue = (name: string): unknown => {
      const value = read(name);
      return isFunction(value) && !functionProps.has(name) ? value() : value;
    };

    const elementProps = {};
    for (const name of options.props) {
      if (slotNames.has(name)) continue;
      Object.defineProperty(elementProps, name, {
        enumerable: true,
        get: () =>
          propValue(name) ?? (functionProps.has(name) && isEventProp(name) ? () => {} : undefined),
      });
    }
    const hostAttributes = (tracked: boolean): HostAttributes => {
      let text = "";
      const names = new Set<string>();
      const add = (name: string, value: unknown) => {
        const output = attribute(name, value);
        if (output !== "") names.add(name);
        text += output;
      };
      let transfer: Record<string, unknown> | undefined;
      const current: Record<string, unknown> = {};
      for (const name of options.props) {
        if (slotNames.has(name)) continue;
        const value = propValue(name);
        current[name] = value;
        if ((typeof value === "object" && value !== null) || typeof value === "function") {
          if (ctx.owner !== null) continue;
          checkSerializable(value, `<${tag}> ${name}`, true);
          (transfer ??= {})[name] = value;
          continue;
        }
        add(propToAttribute(name), value);
      }
      for (const name of Object.keys(descriptors)) {
        if (options.props.includes(name) || slotNames.has(name) || name === "ref") continue;
        if (reservedProp(name) === "load:" || (name === "slot" && ctx.slot !== undefined)) continue;
        const raw = read(name);
        if (isEventProp(name) && isFunction(raw)) continue;
        add(name, this.value(raw, ctx, tracked));
      }
      if (key !== undefined) text += attribute(tagAttributeName("key"), key);
      if (ctx.slot !== undefined) text += attribute("slot", ctx.slot);
      return { text, names, transfer, current };
    };
    const attributes = this.settle(ctx, hostAttributes);

    const form: FormProps | undefined = options.form
      ? {
          name: () => propValue("name"),
          disabled: () => ctx.disabled() || disables(propValue("disabled")),
        }
      : undefined;
    const shadow = this.runsElements
      ? this.runElement(component, elementProps, record, ctx, form)
      : undefined;
    const chunks: Chunk[] = shadow?.chunks ?? [];
    const aria = ariaAttributes(shadow?.internals ?? {});
    const hostId = form && shadow ? this.settle(ctx, () => propValue("id")) : undefined;
    for (const name of Object.keys(descriptors)) {
      if (!slotNames.has(name)) continue;
      const slot = name === "children" ? "" : name;
      const content = asNode(runWithOwner(ctx.owner, () => untrack(() => read(name))));
      const boundary = shadow?.slots.get(slot) ?? ctx.boundary;
      const light: WalkCtx = {
        owner: ctx.owner,
        path: ctx.path,
        boundary,
        depth: ctx.depth,
        head: ctx.head === "none" ? "none" : "element",
        slots: ctx.slots,
        slot: slot === "" ? undefined : slot,
        disabled: ctx.disabled,
        legend: undefined,
        fallback: ctx.fallback,
      };
      if (boundary === ctx.boundary) {
        this.walk(content, light, chunks);
      } else {
        const own = this.chunks(content, light);
        boundary.slotted.push(own);
        chunks.push({ kind: "slotted", slotted: { boundary, chunks: own, path: ctx.path } });
      }
    }
    chunks.push(`</${tag}>`);
    const open = ({ text, names, transfer, current }: HostAttributes, at: Out): string => {
      const added = aria.filter(([name]) => !names.has(name));
      const ariaText =
        added.map(([name, value]) => attribute(name, value)).join("") +
        (added.length > 0 ? attribute(ARIA_ATTRIBUTE, added.map(([name]) => name).join(" ")) : "");
      const named = [...names, ...added.map(([name]) => name)].some(
        (name) => name === "aria-label" || name === "aria-labelledby",
      );
      const labelled =
        (typeof hostId === "string" || typeof hostId === "number") && !named
          ? this.labels.host(scopeOf(ctx), String(hostId))
          : "";
      const start = `<${tag}${attribute(HOST_ATTRIBUTE, id)}${attribute(LOAD_ATTRIBUTE, load)}${text}${ariaText}${labelled}`;
      if (shadow === undefined) {
        const values = {
          [REFRESH_PROPS_KEY]: current,
          ...(transfer && { [PROPS_KEY]: transfer }),
        } satisfies RefreshValues;
        at.addRefreshData(id, toScript(values, `<${tag}>`));
        return `${start}>`;
      }
      if (transfer) this.send(record, PROPS_KEY, Promise.resolve(toScript(transfer, `<${tag}>`)));
      const keys = record.seal(transfer ? [PROPS_KEY] : [], at.shown);
      const om = keys.length > 0 ? attribute(AWAITED_ATTRIBUTE, keys.join(" ")) : "";
      return `${start}${om}><template shadowrootmode="open"${form ? " shadowrootdelegatesfocus" : ""}>`;
    };
    out.push({
      kind: "host",
      host: { attributes, open, chunks, announce, delivered, sheets: shadow?.sheets ?? [] },
    });
  }

  /**
   * 要素の関数 `component` を `props` で実行し、Shadow DOM の中身の出力の単位の列を返す。
   * `slots` は、Shadow DOM の `<slot>` の名前ごとに、その `<slot>` を囲む境界を表す。
   * `internals` は、要素の関数が ctx の `internals` に代入した値である。`form` は、フォームの部品のホストの `name` と `disabled` を返す関数で、フォームの部品でない要素では `undefined` である。
   * 要素の関数が `form.value` を呼んだときは、要素の関数を実行した後に、渡した関数と、`form` の `name` と `disabled` を評価し、hidden input を `</template>` の後に 1 つ出力する。値が未解決なら、解決してから評価し直す。
   */
  private runElement(
    component: ElementComponent<unknown>,
    props: object,
    record: HostRecord,
    ctx: WalkCtx,
    form: FormProps | undefined,
  ): {
    readonly chunks: Chunk[];
    readonly slots: ReadonlyMap<string, Boundary>;
    readonly internals: object;
    readonly sheets: readonly SheetInfo[];
  } {
    const { tag } = record;
    const sheets: SheetInfo[] = [];
    const chunks: Chunk[] = [];
    const slots = new Map<string, Boundary>();
    let owner: Owner | null = null;
    let tree: Node = null;
    const internals = {};
    /** ホストの `name`、要素の関数が `form.value` に渡した関数の値、ホストの `disabled` を返す関数である。 */
    let submitted: (() => readonly [unknown, unknown, boolean]) | undefined;
    /** `css` に渡したスタイルを、DSD の先頭に出力する HTML にして、呼び出した順に保持する。 */
    const styles: string[] = [];
    const css = elementCss(styles, sheets);
    const elementCtx: Ctx = {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      host: serverHost as HTMLElement,
      css,
      onMount: () => {},
      expose: () => {},
      form: form
        ? {
            value: (fn) => {
              submitted = () => [form.name(), fn(), form.disabled()];
            },
            validity: () => {},
            onReset: () => {},
            onRestore: () => {},
            disabled: form.disabled,
          }
        : unsupportedFormControls(tag),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      internals: internals as ElementInternals,
    };
    const scope = createScope(
      <T>(memoKey: string, fn: (prev: T | undefined) => T | PromiseLike<T>) =>
        createMemo<T>((prev) => {
          const result = fn(prev);
          if (isPromiseLike(result) && record.listMemo(memoKey)) {
            this.sendMemo(record, `<${tag}> の memo ${memoKey}`, memoKey, result);
          }
          return result;
        }),
      record,
    );
    createRoot((dispose) => {
      this.disposers.push(dispose);
      owner = getOwner();
      tree = asNode(untrack(() => withScope(scope, () => component(props, elementCtx))));
    });
    const shadowCtx: WalkCtx = {
      owner,
      path: [...ctx.path, record],
      boundary: ctx.boundary,
      slots,
      slot: undefined,
      depth: ctx.depth,
      head: "element",
      disabled: notDisabled,
      legend: undefined,
      fallback: false,
    };
    const read = submitted;
    const input =
      read &&
      this.chunkOf(this.settle(shadowCtx, read), ([given, value, off]) =>
        hiddenInput(tag, given, value, off),
      );
    chunks.push(styles.join(""));
    this.walk(tree, shadowCtx, chunks);
    chunks.push("</template>");
    if (input !== undefined) chunks.push(input);
    return { chunks, slots, internals, sheets };
  }

  /**
   * 境界が保留中かどうかを返す。領域の中に穴があるか、境界の中の `<slot>` に配置するスロットの内容に穴があれば保留中である。
   * `blocking` では、常に偽を返す。
   */
  private isPending(boundary: Boundary): boolean {
    return !this.blocking && (hasHole(boundary.region) || boundary.slotted.some(hasHole));
  }

  /** 出力の単位の列を、穴の内容を待ってから、`out` の位置に出力する文字列にする。 */
  private async serialize(chunks: readonly Chunk[], out: Out): Promise<string> {
    const parts = await Promise.all(chunks.map((chunk) => this.serializeChunk(chunk, out)));
    return parts.join("");
  }

  /** 出力の単位を文字列にする。保留中の境界は、フォールバックを目印で囲んで出力し、中身を後送りにする。 */
  private async serializeChunk(chunk: Chunk, out: Out): Promise<string> {
    if (typeof chunk === "string") return chunk;
    switch (chunk.kind) {
      case "fail":
        throw chunk.fail;
      case "hole":
        return this.serialize(await chunk.hole, out);
      case "mark": {
        const boundary = chunk.mark;
        if (!this.isPending(boundary)) return this.serialize(boundary.region, out);
        this.schedule(boundary, out);
        return marker(boundary.id, await this.serialize(chunk.fallback(), out));
      }
      case "slotted": {
        const { boundary, chunks, path } = chunk.slotted;
        const { flush } = boundary;
        if (!flush || !hasHole(chunks)) return this.serialize(chunks, out);
        const id = `p${++this.seq}`;
        const into = out.into(flush);
        const html = this.serialize(chunks, into);
        html.catch(() => {});
        boundary.patches.push({ id, path, html, out: into });
        return marker(id);
      }
      case "host": {
        const { attributes, open, chunks, announce, delivered, sheets } = chunk.host;
        if (delivered) out.addElement(delivered);
        for (const sheet of sheets) out.addSheet(sheet);
        const inner = await this.serialize(chunks, out);
        const resolved = await attributes;
        const start = open(resolved, out);
        if (announce) out.addScript(announce);
        return start + inner;
      }
      case "errored": {
        const { chunks, node, ctx } = chunk.errored;
        let failed = false;
        const kept = out.conditional(() => !failed);
        try {
          const html = await this.serialize(chunks, kept);
          out.absorb(kept);
          return html;
        } catch (error) {
          failed = true;
          const { flush } = out;
          const thrown = classify(error);
          switch (thrown.kind) {
            case "redirect":
              throw error;
            case "moved":
              if (flush.kind === "shell" || thrown.safe) throw error;
              break;
            case "notFound":
              if (flush.kind === "shell") throw error;
              flush.noindex = true;
              break;
            case "response":
              if (flush.kind === "shell") throw error;
              break;
            case "schema":
            case "error":
              if (flush.kind === "shell") this.caught = Math.max(this.caught, node.status ?? 500);
              break;
          }
          return this.serialize(this.chunks(node.fallback(error), ctx), out);
        }
      }
    }
  }

  /**
   * 境界の中身と差し替えを、目印の位置の出力がページに現れた後に出力する。
   * 中身の出力に失敗したときは、規則に合う移動先への移動なら移動させ、それ以外ならエラーを記録する。
   * 中身の出力に失敗したときと、目印の位置の出力がページに現れないときは、中身と差し替えを出力しない。
   */
  private schedule(boundary: Boundary, out: Out): void {
    this.interactive = true;
    const flush: DeferredFlush = {
      ...resolvable(),
      kind: "deferred",
      noindex: false,
    };
    boundary.flush = flush;
    for (const host of boundary.path) host.defer();
    this.track(
      (async () => {
        const regionOut = Out.of(flush);
        const content = this.serialize(boundary.region, regionOut);
        await content.catch(() => {});
        if (!(await out.shown)) {
          this.abandon(boundary, flush);
          return;
        }
        let region: string;
        let patches: [Patch, string][];
        try {
          region = await content;
          patches = await Promise.all(
            boundary.patches.map(async (patch): Promise<[Patch, string]> => [
              patch,
              await patch.html,
            ]),
          );
        } catch (error) {
          const thrown = classify(error);
          if (thrown.kind === "redirect" || (thrown.kind === "moved" && thrown.safe)) {
            this.write(
              `<script>location.replace(${scriptJson(thrown.location)})</script><meta http-equiv="refresh" content="0;url=${escapeAttribute(thrown.location)}">`,
            );
          } else {
            console.error(
              thrown.kind === "moved"
                ? `[rinka] 移動先 ${JSON.stringify(thrown.location)} は、相対 URL でも http や https の URL でもないので、移動させずにフォールバックのまま残します。`
                : "[rinka] シェルを送った後に、<Loading> の中身の描画に失敗しました。フォールバックのまま残します。",
              error,
            );
          }
          this.abandon(boundary, flush);
          return;
        }
        const spec: SwapSpec = {
          b: boundary.id,
          bp: hostIds(boundary.path),
          p: patches.map(([patch]) => [patch.id, hostIds(patch.path)]),
        };
        let noindex = "";
        if (flush.noindex && !this.noindexSent) {
          this.noindexSent = true;
          noindex =
            '<meta name="robots" content="noindex"><script>document.head.append(document.currentScript.previousSibling.cloneNode())</script>';
        }
        const outs = [regionOut, ...patches.map(([patch]) => patch.out)];
        const [resolvedRegion, ...patched] = this.labels.resolve([
          region,
          ...patches.map(([, html]) => html),
        ]);
        this.reveal(
          flush,
          noindex +
            `<template ${BOUNDARY_CONTENT_ATTRIBUTE}="${boundary.id}">${this.takeProperties(outs)}${resolvedRegion}</template>` +
            patches
              .map(
                ([patch], index) =>
                  `<template ${PATCH_ATTRIBUTE}="${patch.id}">${patched[index]}</template>`,
              )
              .join("") +
            this.tailOf(outs) +
            swapScript(spec),
        );
        this.finishBoundary(boundary);
      })(),
    );
  }

  /**
   * `promise` が解決した値を、シェルを出力した後に `$rinka.d` でホストに送る。
   * 失敗した値とシリアライズできない値の代わりに、値が無いことを表す `$rinka.n` を送る。シリアライズできない値は記録する。
   */
  private sendMemo(
    host: HostRecord,
    path: string,
    key: string,
    promise: PromiseLike<unknown>,
  ): void {
    this.send(
      host,
      key,
      (async () => {
        let resolved: unknown;
        try {
          resolved = await promise;
        } catch {
          return noValue;
        }
        try {
          return toScript(resolved, path);
        } catch (error) {
          console.error("[rinka] memo の値を送れないので、要素がブラウザで計算し直します。", error);
          return noValue;
        }
      })(),
    );
  }

  /**
   * `expression` が解決した JS の式を、ホストをページに出力した後に、`$rinka.d` でホストの `key` の値として送る。
   * 送るのは、開始タグの `data-om` に列挙したキーの値だけで、キーごとに 1 回だけ送る。ホストを出力しなければ送らない。
   */
  private send(host: HostRecord, key: string, expression: Promise<string>): void {
    const task = (async () => {
      const value = await expression;
      if (!(await host.take(key))) return;
      this.write(dataScript(host.id, key, value));
    })();
    this.values.add(task);
  }

  /** `flush` のチャンク `html` を書き込み、`flush` のチャンクがページに現れたことを決める。 */
  private reveal(flush: Flush, html: string): void {
    this.write(html);
    flush.resolve(true);
  }

  /** 境界の中身を出力しないことを決める。 */
  private abandon(boundary: Boundary, flush: DeferredFlush): void {
    flush.resolve(false);
    this.finishBoundary(boundary);
  }

  /** 境界を送り終えたものとして数え、Shadow DOM の中の後送りの境界をすべて送り終えたホストに、`@b` の値を送る。 */
  private finishBoundary(boundary: Boundary): void {
    for (const host of boundary.path) {
      if (host.release()) this.send(host, BOUNDARIES_KEY, Promise.resolve("1"));
    }
  }

  private track(task: Promise<void>): void {
    this.pending.add(task);
    const done = () => {
      this.pending.delete(task);
    };
    task.then(done, done);
  }

  /** シェルの後の処理を、処理の中で加えた処理も含めて、すべて終わるまで待つ。 */
  private async drain(): Promise<void> {
    if (this.pending.size === 0) return;
    await Promise.all(this.pending);
    return this.drain();
  }

  /** シェルを描画し、シェルの HTML を返す。 */
  async shell(node: Node): Promise<string> {
    const html = await this.serialize(
      this.chunks(node, {
        owner: null,
        path: [],
        boundary: this.root,
        slots: undefined,
        slot: undefined,
        depth: 0,
        head: "auto",
        disabled: notDisabled,
        legend: undefined,
        fallback: false,
      }),
      this.shellOut,
    );
    return this.labels.resolve([html])[0] ?? "";
  }

  /** `outs` に出力した要素のうち、まだ起動スクリプトに伝えていない要素を、伝えたものとして記録して返す。 */
  private takeUnannounced(outs: readonly Out[]): Delivered[] {
    const merged = new Map<string, Delivered>();
    for (const out of outs) mergeDelivered(merged, out.delivered);
    const fresh = [...merged.values()].filter(({ tag }) => !this.announcedTags.has(tag));
    for (const { tag } of fresh) this.announcedTags.add(tag);
    return fresh;
  }

  /** `outs` のスクリプトと、まだ起動スクリプトに伝えていない要素を伝えるスクリプトを、連結して返す。 */
  private tailOf(outs: readonly Out[]): string {
    return (
      outs.map((position) => position.scriptText).join("") +
      announceScript(this.takeUnannounced(outs))
    );
  }

  /** シェルの文字列 `shell` から目印で囲んだものを取り除き、文書の骨組みに並べる値を返す。 */
  private async takeDocument(shell: string): Promise<DocumentParts> {
    const heads: Promise<HeadOutput>[] = [];
    const others: Exclude<Hoisted, { kind: "head" }>[] = [];
    const rest = shell.replace(
      new RegExp(`<!--${this.nonce}:(\\d+)-->([\\s\\S]*?)<!--${this.nonce}:\\1/-->`, "g"),
      (_match, id: string, html: string) => {
        const hoisted = this.hoisted.get(Number(id));
        if (hoisted === undefined) throw new Error(`目印 ${id} の記録がありません。`);
        if (hoisted.kind === "head") {
          heads.push((async () => ({ html, key: await hoisted.key, depth: hoisted.depth }))());
        } else {
          others.push(hoisted);
        }
        return "";
      },
    );
    const resolved = await Promise.all(heads);
    const leftover = `<!--${this.nonce}:`;
    if (rest.includes(leftover) || resolved.some(({ html }) => html.includes(leftover))) {
      throw new Error("文書の骨組みに移動するものの目印が、取り出した後に残っています。");
    }
    type Root = Extract<Hoisted, { kind: "html" | "body" }>;
    type Navigation = Extract<Hoisted, { kind: "navigation" }>;
    return {
      heads: resolved,
      html: rootAttributesOf(others.filter((record): record is Root => record.kind === "html")),
      body: rootAttributesOf(others.filter((record): record is Root => record.kind === "body")),
      navigation: mergeByName(
        others.filter((record): record is Navigation => record.kind === "navigation"),
      ),
      rest,
    };
  }

  /**
   * 文書の先頭と `shell` を出力し、後送りの境界をすべて出力してから、文書を閉じる。
   * `<head>` には、rinka の `<meta charset="utf-8">`、キーが同じタグを 1 つにしたタグ、`<Navigation>` の出力、`extraHead`、シェルまでに使用したシートの `@property` の規則の `<style>` の順に並べる。
   */
  async finish(this: Renderer<"document">, shell: string, extraHead: string): Promise<void> {
    try {
      const fresh = this.interactive ? this.takeUnannounced([this.shellOut]) : [];
      const script = this.interactive
        ? bootstrap + preloadLinks(fresh) + announceScript(fresh)
        : "";
      const parts = await this.takeDocument(shell);
      const head = `<meta charset="utf-8">${headTags(parts)}`;
      this.reveal(
        this.shellOut.flush,
        `<!doctype html><html${attributesText(parts.html)}><head>${head}${script}${extraHead}${this.takeProperties([this.shellOut])}</head><body${attributesText(parts.body)}>${parts.rest}${this.shellOut.scriptText}`,
      );
      await this.drain();
      for (const host of this.hosts) host.hide();
      await Promise.all(this.values);
      this.write("</body></html>");
    } finally {
      this.dispose();
    }
  }

  /**
   * `outs` の位置に出力した要素が使用したシートのうち、まだ規則を出力していないシートの `@property` の規則の `<style>` を返し、出力したものとして記録する。
   * 規則が無ければ空の文字列を返す。
   */
  private takeProperties(outs: readonly Out[]): string {
    const rules: string[] = [];
    for (const out of outs) {
      for (const [href, properties] of out.sheets) {
        if (this.sentSheets.has(href)) continue;
        this.sentSheets.add(href);
        if (properties !== "") rules.push(properties);
      }
    }
    return rules.length === 0 ? "" : propertiesStyle(rules.join("\n"));
  }

  /** 描き直しの `shell` から、`refreshPage()` のレスポンスの JSON の値を作成する。 */
  async refresh(this: Renderer<"refresh">, shell: string): Promise<RefreshJson> {
    const parts = await this.takeDocument(shell);
    return {
      head: headTags(parts),
      body: parts.rest,
      data: this.shellOut.data,
      elements: this.takeUnannounced([this.shellOut]).map(listed),
      doc: { html: Object.fromEntries(parts.html), body: Object.fromEntries(parts.body) },
    };
  }

  /** 要素の描画の範囲を破棄する。 */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
  }
}

/** 開発時に、要素の外のネイティブのタグ `tag` の `props` にあるイベントハンドラーを警告する。 */
function warnHandlers(tag: string, props: Record<string, unknown>): void {
  if (!import.meta.env?.DEV) return;
  for (const [name, value] of Object.entries(props)) {
    if (isEventProp(name) && isFunction(value)) {
      console.warn(`[rinka] 要素の外の <${tag}> に渡した ${name} は、ブラウザで実行されません。`);
    }
  }
}

/** `value` が、`then` を持つ値かどうかを返す。 */
const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && "then" in value && isFunction(value.then);
