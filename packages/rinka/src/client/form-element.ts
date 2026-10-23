import { createEffect, createSignal, onCleanup, runWithOwner } from "@solidjs/signals";

import { FORM_VALUE_ATTRIBUTE } from "../shared/attributes.ts";
import type { FormControls, FormInvalidity, FormState, RestoreMode } from "../shared/element.ts";
import type { formMembers } from "../shared/host-members.ts";

/** フォームの部品で、Props の型に宣言していても、ホストの属性に反映する props の名前である。 */
export const reflectedProps = ["name", "disabled"] as const;

/** フォームの部品のホストの状態を表す。要素の寿命の間は同じ状態を保持する。 */
interface FormHost {
  /** 要素自身の `disabled` か、外側の `<fieldset disabled>` で無効になっているかどうかを返す。 */
  readonly disabled: () => boolean;
  readonly setDisabled: (disabled: boolean) => void;
  /** 起動している要素の関数が `form.onReset` に渡した関数。 */
  readonly resets: Set<() => void>;
  /** 起動している要素の関数が `form.onRestore` に渡した関数。 */
  readonly restores: Set<(state: FormState, mode: RestoreMode) => void>;
}

const formHosts = new WeakMap<HTMLElement, FormHost>();

/** フォームの部品のホスト `host` の状態を返す。 */
function formHostOf(host: HTMLElement): FormHost {
  let state = formHosts.get(host);
  if (!state) {
    const [disabled, setDisabled] = runWithOwner(null, () =>
      createSignal(false, { ownedWrite: true }),
    );
    state = {
      disabled,
      setDisabled: (value) => setDisabled(value),
      resets: new Set(),
      restores: new Set(),
    };
    formHosts.set(host, state);
  }
  return state;
}

/**
 * `Base` を継承した、フォームの部品として登録するクラスを返す。
 * クラスのプロパティとメソッドのうち、フォームの部品のものは、`internalsOf` が返す `ElementInternals` の同名のものを返す。
 */
export function formElementClass(
  Base: new () => HTMLElement,
  internalsOf: (host: HTMLElement) => ElementInternals,
): CustomElementConstructor {
  return class extends Base implements Pick<ElementInternals, (typeof formMembers)[number]> {
    static formAssociated = true;

    get form() {
      return internalsOf(this).form;
    }

    get labels() {
      return internalsOf(this).labels;
    }

    get validity() {
      return internalsOf(this).validity;
    }

    get validationMessage() {
      return internalsOf(this).validationMessage;
    }

    get willValidate() {
      return internalsOf(this).willValidate;
    }

    checkValidity() {
      return internalsOf(this).checkValidity();
    }

    reportValidity() {
      return internalsOf(this).reportValidity();
    }

    formResetCallback(): void {
      for (const reset of formHostOf(this).resets) reset();
    }

    formStateRestoreCallback(state: FormState, mode: RestoreMode): void {
      for (const restore of formHostOf(this).restores) restore(state, mode);
    }

    formDisabledCallback(disabled: boolean): void {
      formHostOf(this).setDisabled(disabled);
    }
  };
}

/** フォームの部品でない `<tag>` の要素の関数に渡す ctx の `form` を返す。`form.value` と `form.validity` はエラーを送出し、`form.disabled()` は `false` を返す。 */
export function unsupportedFormControls(tag: string): FormControls {
  const unsupported = (name: string) => () => {
    throw new Error(
      `[rinka] <${tag}> はフォームの部品として登録されていないので、form.${name}() を呼び出せません。defineElement の設定に form: true を指定してください。`,
    );
  };
  return {
    value: unsupported("value"),
    validity: unsupported("validity"),
    onReset: () => {},
    onRestore: () => {},
    disabled: () => false,
  };
}

/**
 * フォームの部品のホスト `host` の要素の関数に渡す ctx の `form` を返す。
 * `form.value` は、値を設定した後に、サーバーが Light DOM に出力した hidden input を削除する。`form.onReset` と `form.onRestore` に渡した関数は、呼び出した root を破棄すると登録を解除する。
 */
export function formControls(host: HTMLElement, internals: ElementInternals): FormControls {
  const state = formHostOf(host);
  return {
    value: (fn) => {
      createEffect(fn, (value) => {
        internals.setFormValue(value ?? null);
        host.querySelector(`:scope > input[${FORM_VALUE_ATTRIBUTE}]`)?.remove();
      });
    },
    validity: (fn) => {
      createEffect(fn, (result) => setValidity(internals, result));
    },
    onReset: (fn) => register(state.resets, fn),
    onRestore: (fn) => register(state.restores, fn),
    disabled: state.disabled,
  };
}

/** `fn` を `set` に追加し、呼び出した root を破棄すると `set` から削除する。 */
function register<T>(set: Set<T>, fn: T): void {
  set.add(fn);
  onCleanup(() => set.delete(fn));
}

/** `form.validity` に渡した関数が返した `result` を、`internals` の検証の状態にする。 */
function setValidity(internals: ElementInternals, result: FormInvalidity | null): void {
  if (result === null) {
    internals.setValidity({});
    return;
  }
  const { message, anchor, ...flags } = result;
  const constrained = Object.values(flags).some(Boolean);
  internals.setValidity(constrained ? flags : { customError: true }, message, anchor);
}

/** `value` をホストの属性に反映したときの、属性の値を返す。文字列はそのまま、`true` は空の文字列で、ほかの値は属性が無いことを表す `null` である。 */
export const reflectedValue = (value: unknown): string | null =>
  typeof value === "string" ? value : value === true ? "" : null;

/** `value` を、ホスト `host` の属性 `name` に反映する。 */
export function reflectAttribute(host: HTMLElement, name: string, value: unknown): void {
  const next = reflectedValue(value);
  if (host.getAttribute(name) === next) return;
  if (next === null) host.removeAttribute(name);
  else host.setAttribute(name, next);
}
