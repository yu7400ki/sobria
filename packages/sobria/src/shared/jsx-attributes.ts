import type { PropertiesHyphen } from "csstype";

import type { voidTags } from "./names.ts";
import type { serverFnRef, ServerFnRef } from "./server-fn.ts";

/** 属性の値か、値を返す関数を表す。関数を渡すと、要素の中では、関数が返す値が変わるたびに属性に反映する。 */
export type AttributeValue<T> = T | (() => T);

type V<T> = AttributeValue<T | null | undefined>;
type Text = V<string>;
type Num = V<number | string>;
type Bool = V<boolean>;
type Toggle = V<boolean | "true" | "false">;
type CrossOrigin = V<"anonymous" | "use-credentials" | "">;
type Referrer = V<globalThis.ReferrerPolicy | "">;

/** `style` 属性のオブジェクトが受け付ける CSS のプロパティを、kebab-case の名前で表す。 */
export interface CSSProperties extends PropertiesHyphen {}

/** `style` 属性に渡す、CSS のプロパティ名と CSS 変数の名前をキーにしたオブジェクトを表す。値が `null`、`undefined`、`false` のプロパティは出力しない。 */
type StyleObject = {
  readonly [K in keyof CSSProperties]?: CSSProperties[K] | null | false;
} & {
  readonly [custom: `--${string}`]: string | number | null | undefined | false;
};

/** すべてのネイティブのタグが受け付ける属性を、HTML の属性名で表す。 */
export interface GlobalAttributes {
  readonly [data: `data-${string}`]: V<unknown>;
  readonly [aria: `aria-${string}`]: V<unknown>;
  id?: Text;
  class?: V<string | Readonly<Record<string, unknown>>>;
  style?: V<string | StyleObject>;
  slot?: Text;
  part?: Text;
  exportparts?: Text;
  is?: Text;
  role?: Text;
  title?: Text;
  hidden?: V<boolean | "until-found">;
  lang?: Text;
  dir?: V<"ltr" | "rtl" | "auto">;
  tabindex?: Num;
  inert?: Bool;
  popover?: V<boolean | "auto" | "manual" | "hint">;
  draggable?: Toggle;
  accesskey?: Text;
  autofocus?: Bool;
  contenteditable?: V<boolean | "true" | "false" | "plaintext-only">;
  spellcheck?: Toggle;
  translate?: V<"yes" | "no">;
  nonce?: Text;
  enterkeyhint?: V<"enter" | "done" | "go" | "next" | "previous" | "search" | "send">;
  inputmode?: V<"none" | "text" | "decimal" | "numeric" | "tel" | "search" | "email" | "url">;
}

interface FormControl {
  name?: Text;
  disabled?: Bool;
  form?: Text;
}

interface Link {
  href?: Text;
  target?: Text;
  rel?: Text;
  download?: V<boolean | string>;
  hreflang?: Text;
  type?: Text;
  referrerpolicy?: Referrer;
}

interface Media {
  src?: Text;
  controls?: Bool;
  autoplay?: Bool;
  loop?: Bool;
  muted?: Bool;
  preload?: V<"none" | "metadata" | "auto" | "">;
  crossorigin?: CrossOrigin;
}

interface Quote {
  cite?: Text;
}

interface Edit extends Quote {
  datetime?: Text;
}

interface Cell {
  colspan?: Num;
  rowspan?: Num;
  headers?: Text;
}

/** タグごとの、共通の属性に加えて受け付ける属性を表す。 */
export interface TagAttributes {
  a: Link;
  area: Link & { alt?: Text; coords?: Text; shape?: Text };
  audio: Media;
  base: { href?: Text; target?: Text };
  blockquote: Quote;
  button: FormControl & {
    type?: V<"submit" | "reset" | "button">;
    value?: Text;
    popovertarget?: Text;
    popovertargetaction?: V<"toggle" | "show" | "hide">;
    formaction?: Text;
    formmethod?: Text;
    formnovalidate?: Bool;
  };
  canvas: { width?: Num; height?: Num };
  col: { span?: Num };
  colgroup: { span?: Num };
  data: { value?: Text };
  del: Edit;
  details: { open?: Bool; name?: Text };
  dialog: { open?: Bool; closedby?: V<"any" | "closerequest" | "none"> };
  embed: { src?: Text; type?: Text; width?: Num; height?: Num };
  fieldset: FormControl;
  form: {
    action?: Text | { readonly [serverFnRef]: ServerFnRef<"POST"> };
    method?: V<"get" | "post" | "dialog">;
    enctype?: Text;
    novalidate?: Bool;
    target?: Text;
    autocomplete?: V<"on" | "off">;
    name?: Text;
  };
  html: { lang?: Text };
  iframe: {
    src?: Text;
    srcdoc?: Text;
    name?: Text;
    allow?: Text;
    sandbox?: Text;
    loading?: V<"eager" | "lazy">;
    width?: Num;
    height?: Num;
    referrerpolicy?: Referrer;
  };
  img: {
    src?: Text;
    alt?: Text;
    srcset?: Text;
    sizes?: Text;
    width?: Num;
    height?: Num;
    loading?: V<"eager" | "lazy">;
    decoding?: V<"sync" | "async" | "auto">;
    fetchpriority?: V<"high" | "low" | "auto">;
    crossorigin?: CrossOrigin;
    referrerpolicy?: Referrer;
    usemap?: Text;
    ismap?: Bool;
  };
  input: FormControl & {
    type?: Text;
    alt?: Text;
    src?: Text;
    width?: Num;
    height?: Num;
    dirname?: Text;
    capture?: V<"user" | "environment">;
    formaction?: Text;
    formmethod?: Text;
    formnovalidate?: Bool;
    popovertarget?: Text;
    popovertargetaction?: V<"toggle" | "show" | "hide">;
    value?: V<string | number>;
    checked?: Bool;
    placeholder?: Text;
    required?: Bool;
    readonly?: Bool;
    multiple?: Bool;
    min?: Num;
    max?: Num;
    step?: Num;
    minlength?: Num;
    maxlength?: Num;
    pattern?: Text;
    accept?: Text;
    autocomplete?: Text;
    list?: Text;
    size?: Num;
  };
  ins: Edit;
  label: { for?: Text };
  li: { value?: Num };
  link: {
    rel?: Text;
    href?: Text;
    as?: Text;
    type?: Text;
    media?: Text;
    sizes?: Text;
    hreflang?: Text;
    crossorigin?: CrossOrigin;
    integrity?: Text;
    fetchpriority?: V<"high" | "low" | "auto">;
  };
  map: { name?: Text };
  meta: { name?: Text; content?: Text; charset?: Text; "http-equiv"?: Text; property?: Text };
  meter: { value?: Num; min?: Num; max?: Num; low?: Num; high?: Num; optimum?: Num };
  object: { data?: Text; type?: Text; name?: Text; form?: Text; width?: Num; height?: Num };
  ol: { start?: Num; reversed?: Bool; type?: V<"1" | "a" | "A" | "i" | "I"> };
  optgroup: { label?: Text; disabled?: Bool };
  option: { value?: Text; selected?: Bool; disabled?: Bool; label?: Text };
  output: { for?: Text; name?: Text; form?: Text };
  progress: { value?: Num; max?: Num };
  q: Quote;
  script: {
    src?: Text;
    type?: Text;
    async?: Bool;
    defer?: Bool;
    nomodule?: Bool;
    crossorigin?: CrossOrigin;
    integrity?: Text;
  };
  select: FormControl & { value?: Text; multiple?: Bool; required?: Bool; size?: Num };
  slot: { name?: Text };
  source: { src?: Text; srcset?: Text; sizes?: Text; type?: Text; media?: Text };
  style: { media?: Text };
  td: Cell;
  textarea: FormControl & {
    value?: Text;
    placeholder?: Text;
    required?: Bool;
    readonly?: Bool;
    rows?: Num;
    cols?: Num;
    minlength?: Num;
    maxlength?: Num;
    wrap?: V<"soft" | "hard">;
    autocomplete?: Text;
  };
  th: Cell & { scope?: V<"row" | "col" | "rowgroup" | "colgroup">; abbr?: Text };
  time: { datetime?: Text };
  track: { src?: Text; kind?: Text; srclang?: Text; label?: Text; default?: Bool };
  video: Media & { poster?: Text; playsinline?: Bool; width?: Num; height?: Num };
}

/** タグ `K` が受け付ける属性を表す。属性の型を用意していないタグは、共通の属性だけを受け付ける。 */
export type NativeAttributes<K extends string> = GlobalAttributes &
  (K extends keyof TagAttributes ? TagAttributes[K] : unknown);

/** 子を持てない HTML のタグ（void 要素）の名前を表す。 */
export type VoidTag = (typeof voidTags)[number];

/** 名前を検査しない属性を表す。名前に `-` を含むタグと SVG のタグが受け付ける。 */
export type LooseAttributes = Readonly<Record<string, unknown>>;

/** SVG だけのタグの名前を表す。HTML と同じ名前のタグ（`a`、`script` など）は HTML のタグとして扱う。 */
export type SvgTag = Exclude<keyof SVGElementTagNameMap, keyof HTMLElementTagNameMap>;
