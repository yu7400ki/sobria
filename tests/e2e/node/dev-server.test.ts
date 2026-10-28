import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDevServer, originOf } from "../dev-server.ts";

const root = fileURLToPath(new URL("../fixtures/basic", import.meta.url));

/** パスの区切りを `/` にする。 */
const posix = (path: string) => path.split(sep).join("/");

let server: ViteDevServer;
let origin: string;
/** 開発サーバーが出力した警告である。 */
const warnings: string[] = [];

beforeAll(async () => {
  // e2e のプロジェクトの開発サーバーと依存の事前バンドルを共有しないように、キャッシュのディレクトリを分ける
  server = await createDevServer(root, {
    server: { port: 0 },
    cacheDir: fileURLToPath(new URL("../node_modules/.vite/node-dev-server", import.meta.url)),
  });
  const { logger } = server.config;
  const warn = logger.warn.bind(logger);
  logger.warn = (message, options) => {
    warnings.push(message);
    warn(message, options);
  };
  await server.listen();
  origin = originOf(server);
});

afterAll(async () => {
  await server.close();
});

/** `name` のサーバー関数を 1 つだけ定義するモジュールのソースを返す。 */
const removedSource = (name: string) =>
  `import { defineServerFn } from "rinka/server";\nexport const ${name} = defineServerFn(() => "${name}");\n`;

/** 開発サーバーの、`src/lib/removed.ts` の `name` のサーバー関数を RPC で呼び出す。 */
const callRemoved = (name: string) =>
  fetch(`${origin}/_rinka/fn/${encodeURIComponent(`src/lib/removed.ts#${name}`)}`, {
    method: "POST",
  });

/** `css` が真なら `./styled.css` を import する、`src/routes/styled/page.tsx` のソースを返す。 */
const pageSource = (css: boolean) =>
  `${css ? 'import "./styled.css";\n' : ""}export default function Styled() {\n  return <p>styled</p>;\n}\n`;

/** 開発サーバーの `/styled` が `styled.css` の <link> を出力するかどうかを返す。ページが 200 を返さなければ undefined を返す。 */
const link = async () => {
  const response = await fetch(`${origin}/styled`);
  if (response.status !== 200) return undefined;
  return (await response.text()).includes('href="/src/routes/styled/styled.css?direct"');
};

/** クライアントの環境で変換した、`src/elements/` の要素のファイル `name` のモジュールのコードを返す。変換の結果が無ければ空文字列を返し、変換に失敗したら、エラーを文字列にして返す。 */
const transformed = async (name = "typed.tsx") =>
  server.environments.client.transformRequest(`/src/elements/${name}`).then(
    (result) => result?.code ?? "",
    (error: unknown) => String(error),
  );

/** 要素の props の型に `../lib/typed-props.ts` の `Props` を使用する、要素のファイルのソースである。 */
const typedSource =
  'import type { Props } from "../lib/typed-props.ts";\nexport default function Typed(props: Props) {\n  return <p>{String(props.value)}</p>;\n}\n';

/** `value` の型を `type` にした `OwnerProps` 型を export する、要素のファイルのソースを返す。 */
const ownerSource = (type: string) =>
  `export type OwnerProps = { value?: ${type} };\nexport default function Owner(props: OwnerProps) {\n  return <p>{String(props.value)}</p>;\n}\n`;

/** 2 つの要素のモジュールが、どちらも `value` の props を分類 `kind` で登録するまで待つ。 */
const registered = (kind: string) =>
  Promise.all(
    ["owner.tsx", "user.tsx"].map((name) =>
      vi.waitUntil(async () => (await transformed(name)).includes(`"value": "${kind}"`), {
        timeout: 5000,
      }),
    ),
  );

describe("開発サーバー", () => {
  it("ページを描画しても、ページの CSS を読み込む動的 import について警告しない", async () => {
    await fetch(`${origin}/`);
    expect(warnings.filter((message) => message.includes("dynamic import"))).toEqual([]);
  });

  it("src/routes の page.tsx を描画したページを返す", async () => {
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    const html = await response.text();
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<script type="module" src="/@vite/client"></script>');
    expect(html).toContain("<h1>basic</h1>");
    expect(html).toContain('<app-counter data-oh="h1"');
  });

  it("ページの無いパスには 404 を返す", async () => {
    const response = await fetch(`${origin}/missing`);
    expect(response.status).toBe(404);
  });

  it("ページの描画で投げたエラーは、Vite のエラーのオーバーレイでメッセージを表示する 500 のページにする", async () => {
    const response = await fetch(`${origin}/boom`);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("ページの描画に失敗しました");
    expect(body).toContain('import { ErrorOverlay } from "/@vite/client";');
  });

  it("サーバー関数のエンドポイントは、変換の時点でサーバー関数の定義を見つけたモジュールだけを読み込む", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rinka-probe-"));
    try {
      const marker = join(dir, "marker.txt");
      const payload = join(dir, "payload.mjs");
      await writeFile(
        payload,
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "x");
`,
      );
      const ids = [`${posix(relative(root, payload))}#x`, `@fs/${posix(payload)}#x`];
      const responses = await Promise.all(
        ids.map((id) => fetch(`${origin}/_rinka/fn/${encodeURIComponent(id)}`)),
      );
      expect(responses.map((response) => response.status)).toEqual([404, 404]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("まだ変換していないモジュールのサーバー関数を、RPC で呼び出せる", async () => {
    const response = await fetch(
      `${origin}/_rinka/fn/${encodeURIComponent("src/lib/late.ts#echo")}`,
      {
        method: "POST",
      },
    );
    expect(await response.json()).toEqual({ ok: "late" });
  });

  it("ファイルから削除したサーバー関数の ID は、HMR が無効でも、ファイルを変更した後に 404 になる", async () => {
    const file = join(root, "src/lib/removed.ts");
    try {
      await writeFile(file, removedSource("gone"));
      server.watcher.emit("add", posix(file));
      await vi.waitUntil(async () => (await callRemoved("gone")).status === 200, { timeout: 2000 });
      await writeFile(file, removedSource("kept"));
      server.watcher.emit("change", posix(file));
      // Vite は変更の通知を非同期に処理するので、変換の結果が変わるまで待つ
      await vi.waitUntil(async () => (await callRemoved("gone")).status === 404, { timeout: 2000 });
    } finally {
      await rm(file, { force: true });
    }
  });

  it("要素が import した Props の型のファイルが変更されると、要素を新しい props の分類で登録し直す", async () => {
    const typesFile = join(root, "src/lib/typed-props.ts");
    const elementFile = join(root, "src/elements/typed.tsx");
    try {
      await writeFile(typesFile, "export type Props = { value?: string };\n");
      await writeFile(elementFile, typedSource);
      await vi.waitUntil(async () => /"value": "string"/.test(await transformed()), {
        timeout: 5000,
      });
      await writeFile(typesFile, "export type Props = { value?: number };\n");
      server.watcher.emit("change", posix(typesFile));
      await vi.waitUntil(async () => /"value": "number"/.test(await transformed()), {
        timeout: 5000,
      });
    } finally {
      await rm(elementFile, { force: true });
      await rm(typesFile, { force: true });
    }
  }, 20_000);

  it("要素が import した Props の型のファイルが作成されると、要素を props の分類で登録し直す", async () => {
    const typesFile = join(root, "src/lib/typed-props.ts");
    const elementFile = join(root, "src/elements/typed.tsx");
    try {
      await writeFile(elementFile, typedSource);
      await vi.waitUntil(async () => (await transformed()).includes("解決できない"), {
        timeout: 5000,
      });
      await writeFile(typesFile, "export type Props = { value?: number };\n");
      server.watcher.emit("add", posix(typesFile));
      await vi.waitUntil(async () => /"value": "number"/.test(await transformed()), {
        timeout: 5000,
      });
    } finally {
      await rm(elementFile, { force: true });
      await rm(typesFile, { force: true });
    }
  }, 20_000);

  it("ほかの要素のファイルで宣言した Props の型が変更されると、その型を import する要素も登録し直す", async () => {
    const ownerFile = join(root, "src/elements/owner.tsx");
    const userFile = join(root, "src/elements/user.tsx");
    try {
      await writeFile(ownerFile, ownerSource("string"));
      await writeFile(
        userFile,
        'import type { OwnerProps } from "./owner.tsx";\nexport default function User(props: OwnerProps) {\n  return <p>{String(props.value)}</p>;\n}\n',
      );
      await registered("string");
      await writeFile(ownerFile, ownerSource("number"));
      server.watcher.emit("change", posix(ownerFile));
      await registered("number");
    } finally {
      await rm(userFile, { force: true });
      await rm(ownerFile, { force: true });
    }
  }, 30_000);

  it("ページの CSS の import を追加か削除すると、HMR が無効でも、次のリクエストの <link> に反映する", async () => {
    const dir = join(root, "src/routes/styled");
    const pageFile = join(dir, "page.tsx");
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "styled.css"), "p { color: red; }\n");
      await writeFile(pageFile, pageSource(false));
      await vi.waitUntil(async () => (await link()) === false, { timeout: 5000 });
      await writeFile(pageFile, pageSource(true));
      server.watcher.emit("change", posix(pageFile));
      await vi.waitUntil(async () => (await link()) === true, { timeout: 5000 });
      await writeFile(pageFile, pageSource(false));
      server.watcher.emit("change", posix(pageFile));
      await vi.waitUntil(async () => (await link()) === false, { timeout: 5000 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("form の action に渡したサーバー関数に、JS が無いときと同じ multipart の送信をすると、Referer のページを 200 で返す", async () => {
    const html = await (await fetch(`${origin}/fns`)).text();
    const action = `/_rinka/fn/${encodeURIComponent("src/lib/fns.ts#save")}`;
    expect(html).toContain(`<form action="${action}" method="post" enctype="multipart/form-data">`);
    const body = new FormData();
    body.append("title", "a");
    const response = await fetch(`${origin}${action}`, {
      method: "POST",
      body,
      headers: { referer: `${origin}/fns` },
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`<form action="${action}"`);
  });

  it("ページの要素の中から、props で受け取ったサーバー関数と import したサーバー関数を RPC で呼び出せる", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${origin}/fns`);
      await page.locator("app-pinger[data-started]").waitFor({ timeout: 5000 });
      // 前のテストの /boom のエラーが、Vite のエラーのオーバーレイとしてボタンの上に表示されるので、click のイベントを直接送る
      await page.locator("app-pinger button").dispatchEvent("click");
      await page.locator("app-pinger button", { hasText: "pong pong" }).waitFor({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("要素から refreshPage() を呼び出すと、要素の状態を保ったまま、本文と <title> と要素の props を描き直しで更新する", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${origin}/refresh`);
      await page.locator("app-refresher[data-started]").waitFor({ timeout: 5000 });
      const before = Number(await page.locator("#renders").textContent());
      await page.locator("app-refresher #count").dispatchEvent("click");
      await page
        .locator("app-refresher #count", { hasText: `v${before} 1` })
        .waitFor({ timeout: 5000 });
      await page.locator("app-refresher #refresh").dispatchEvent("click");
      const after = before + 1;
      await page.locator("#renders", { hasText: String(after) }).waitFor({ timeout: 5000 });
      await page
        .locator("app-refresher #count", { hasText: `v${after} 1` })
        .waitFor({ timeout: 5000 });
      expect(await page.title()).toBe(`refresh ${after}`);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("要素から POST のサーバー関数を呼び出すと、要素の状態を保ったまま、同じレスポンスで本文と <title> と要素の props を描き直す", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${origin}/refresh`);
      await page.locator("app-refresher[data-started]").waitFor({ timeout: 5000 });
      const before = Number(await page.locator("#renders").textContent());
      await page.locator("app-refresher #count").dispatchEvent("click");
      await page
        .locator("app-refresher #count", { hasText: `v${before} 1` })
        .waitFor({ timeout: 5000 });
      const requests: string[] = [];
      page.on("request", (request) => requests.push(new URL(request.url()).pathname));
      await page.locator("app-refresher #save").dispatchEvent("click");
      const after = before + 1;
      await page.locator("#renders", { hasText: String(after) }).waitFor({ timeout: 5000 });
      await page
        .locator("app-refresher #count", { hasText: `v${after} 1` })
        .waitFor({ timeout: 5000 });
      expect(await page.title()).toBe(`refresh ${after}`);
      expect([
        requests.filter((path) => path.startsWith("/_rinka/fn/")).length,
        requests.filter((path) => path === "/refresh").length,
      ]).toEqual([1, 0]);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("refreshPage() のレスポンスがリダイレクトのときは、ページを読み込み直してリダイレクト先に移動する", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${origin}/refresh-moved`);
      await page.locator("app-refresher[data-started]").waitFor({ timeout: 5000 });
      await page.locator("app-refresher #refresh").dispatchEvent("click");
      await page.waitForURL(`${origin}/refresh`, { timeout: 5000 });
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("JS があるときのフォームの送信は、要素の状態を保ったまま本文を描き直し、失敗したら URL を変えずに error.tsx を表示する", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${origin}/notes`);
      await page.locator("app-refresher[data-started]").waitFor({ timeout: 5000 });
      const before = await page.locator("#notes li").count();
      await page.locator("app-refresher #count").dispatchEvent("click");
      await page.locator("input[name=title]").fill("draft");
      await page.locator("#add").dispatchEvent("click");
      await page.locator("#notes li").nth(before).waitFor({ timeout: 5000 });
      await page.locator("app-refresher #count", { hasText: "notes 1" }).waitFor({ timeout: 5000 });
      expect(await page.locator("input[name=title]").inputValue()).toBe("");
      expect(page.url()).toBe(`${origin}/notes`);
      await page.locator("#fail").dispatchEvent("click");
      await page.locator("#error", { hasText: "note failed" }).waitFor({ timeout: 5000 });
      expect(page.url()).toBe(`${origin}/notes`);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it.each([true, false])(
    "JS が %s のときに、検証に失敗したフォームの送信は、handler が返した入力した値とエラーを、送信したページに表示する",
    async (javaScriptEnabled) => {
      const browser = await chromium.launch();
      try {
        const page = await (await browser.newContext({ javaScriptEnabled })).newPage();
        await page.goto(`${origin}/signup`);
        if (javaScriptEnabled) {
          await page.locator("app-refresher[data-started]").waitFor({ timeout: 5000 });
          await page.locator("app-refresher #count").dispatchEvent("click");
        }
        await page.locator("input[name=name]").fill("admin");
        await page.locator("#signup").click();
        await page
          .locator("#error", { hasText: "この名前は使用されています" })
          .waitFor({ timeout: 5000 });
        expect(await page.locator("input[name=name]").getAttribute("value")).toBe("admin");
        if (javaScriptEnabled) {
          expect(await page.locator("app-refresher #count").textContent()).toBe("signup 1");
        }
        expect(new URL(page.url()).pathname).toBe(
          javaScriptEnabled
            ? "/signup"
            : "/_rinka/fn/" + encodeURIComponent("src/lib/signup.ts#signup"),
        );
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it("Vite が処理するリクエストは、Vite が返す", async () => {
    const response = await fetch(`${origin}/src/elements/counter.tsx`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('__rinka_defineElement("app-counter"');
  });
});
