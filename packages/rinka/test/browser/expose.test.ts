import { createRoot, flush } from "@solidjs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineElement } from "../../src/client/element.ts";
import { jsx } from "../../src/client/jsx-runtime.ts";
import type { Ctx } from "../../src/shared/element.ts";
import { signal } from "../../src/shared/signals.ts";

let count = 0;
const nextTag = () => `test-expose-${++count}`;

afterEach(() => {
  vi.unstubAllEnvs();
});

/** `members` を expose する要素を JSX で作成し、ホストを返す。 */
function mountExposing(members: object, props: readonly string[] = []): HTMLElement {
  const El = defineElement(
    nextTag(),
    (_props: object, ctx: Ctx) => {
      ctx.expose(members);
      return null;
    },
    { props },
  );
  return createRoot(() => jsx(El, {})) as unknown as HTMLElement;
}

describe("ctx.expose", () => {
  it("getter と setter を含むプロパティを、記述子のままホストに追加する", () => {
    const [value, setValue] = signal("a");
    const el = mountExposing({
      get value() {
        return value();
      },
      set value(next: string) {
        setValue(next);
      },
      open: () => "opened",
    }) as HTMLElement & { value: string; open(): string };
    expect(el.value).toBe("a");
    el.value = "b";
    flush();
    expect(el.value).toBe("b");
    expect("get" in Object.getOwnPropertyDescriptor(el, "value")!).toBe(true);
    expect(el.open()).toBe("opened");
  });

  it("HTMLElement のメンバーを上書きできる", () => {
    const calls: string[] = [];
    const el = mountExposing({ focus: () => calls.push("focus") });
    el.focus();
    expect(calls).toEqual(["focus"]);
  });

  it("開発時は、構造を変更するメンバー、フォームの部品の API、props の名前を公開するとエラーにする", () => {
    expect(() => mountExposing({ remove: () => {} })).toThrow(
      /^<test-expose-\d+> "remove" は expose で公開できません。/,
    );
    expect(() => mountExposing({ checkValidity: () => true })).toThrow(
      '"checkValidity" は expose で公開できません。',
    );
    expect(() => mountExposing({ label: "x" }, ["label"])).toThrow(
      '"label" は expose で公開できません。',
    );
  });

  it("開発時は、列挙できないプロパティの名前も検査する", () => {
    const members = Object.defineProperty({}, "remove", { value: () => {}, enumerable: false });
    expect(() => mountExposing(members)).toThrow('"remove" は expose で公開できません。');
  });

  it("開発時でなければ、名前を検査せずに公開する", () => {
    vi.stubEnv("DEV", false);
    const el = mountExposing({ remove: () => "removed" }) as unknown as { remove(): string };
    expect(el.remove()).toBe("removed");
  });
});
