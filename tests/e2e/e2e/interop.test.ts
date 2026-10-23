import { createElement } from "react";
import { flushSync as flushReact } from "react-dom";
import { createRoot } from "react-dom/client";
import { flushSync as flushSvelte, mount, unmount } from "svelte";
import { beforeAll, expect, inject, it, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";

import { counterProps } from "./interop/counter-props.svelte.ts";
import Counter from "./interop/Counter.svelte";

/** `predicate` が真になるまで 10 ms ごとに確認し、2 秒で真にならなければ失敗する。 */
const until = (predicate: () => boolean) =>
  vi.waitUntil(predicate, { timeout: 2000, interval: 10 });

beforeAll(async () => {
  await import(/* @vite-ignore */ `/@fs/${inject("libraryDir")}/acme-counter.js`);
});

/** テストのたびに、要素を置く空の要素を作成する。 */
function container(): HTMLElement {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

/**
 * `target` の中の `<acme-counter>` が `1` を表示し、`update` で `count` を 5 にすると同じ要素のまま `5` を表示し、
 * ボタンを押すと `like-click` のイベントの `detail` の 6 を `events` が受け取ることを確認する。
 */
async function check(target: HTMLElement, update: () => Promise<void> | void, events: unknown[]) {
  const element = target.querySelector("acme-counter")!;
  const text = () => element.shadowRoot?.querySelector("button")?.textContent;
  await until(() => text() === "1");
  await update();
  expect(target.querySelector("acme-counter")).toBe(element);
  await until(() => text() === "5");
  element.shadowRoot!.querySelector("button")!.click();
  await until(() => events.length > 0);
  expect(events).toEqual([6]);
}

it("React から、count をプロパティで渡し、onlike-click でイベントを受け取る", async () => {
  const target = container();
  const events: unknown[] = [];
  const root = createRoot(target);
  const render = (count: number) =>
    flushReact(() =>
      root.render(
        createElement("acme-counter", {
          count,
          "onlike-click": (event: CustomEvent) => events.push(event.detail),
        }),
      ),
    );
  render(1);
  await check(target, () => render(5), events);
  root.unmount();
});

it("Vue から、count をプロパティで渡し、onLikeClick でイベントを受け取る", async () => {
  const target = container();
  const events: unknown[] = [];
  const count = ref(1);
  const app = createApp({
    render: () =>
      h("acme-counter", {
        count: count.value,
        onLikeClick: (event: CustomEvent) => events.push(event.detail),
      }),
  });
  app.config.compilerOptions.isCustomElement = (tag) => tag.startsWith("acme-");
  app.mount(target);
  await check(
    target,
    async () => {
      count.value = 5;
      await nextTick();
    },
    events,
  );
  app.unmount();
});

it("Svelte から、count をプロパティで渡し、onlike-click でイベントを受け取る", async () => {
  const target = container();
  const events: unknown[] = [];
  const props = counterProps((detail) => events.push(detail));
  const component = mount(Counter, { target, props });
  flushSvelte();
  await check(
    target,
    () => {
      props.count = 5;
      flushSvelte();
    },
    events,
  );
  await unmount(component);
});

it("Angular（JIT、zoneless）から、[count] でプロパティを渡し、(like-click) でイベントを受け取る", async () => {
  // JIT のコンパイラは、Angular のほかのモジュールより先に読み込む
  await import("@angular/compiler");
  const { Component, CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection, signal } =
    await import("@angular/core");
  const { bootstrapApplication } = await import("@angular/platform-browser");
  const target = container();
  class App {
    readonly count = signal(1);
    readonly events: unknown[] = [];
    like(event: Event): void {
      this.events.push((event as CustomEvent).detail);
    }
  }
  Component({
    selector: "interop-root",
    template: `<acme-counter [count]="count()" (like-click)="like($event)"></acme-counter>`,
    schemas: [CUSTOM_ELEMENTS_SCHEMA],
  })(App);
  target.append(document.createElement("interop-root"));
  const application = await bootstrapApplication(App, {
    providers: [provideZonelessChangeDetection()],
  });
  const app = application.components[0]!.instance as App;
  await check(
    target,
    () => {
      app.count.set(5);
      application.tick();
    },
    app.events,
  );
  application.destroy();
});
