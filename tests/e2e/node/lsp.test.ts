import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rinkaBin, run, tscBin } from "./typescript.ts";

/** 言語サーバーに接続するテスト用のアプリのルートである。 */
const root = fileURLToPath(new URL("../fixtures/types", import.meta.url));

/** 言語サーバーとの JSON-RPC のメッセージを表す。 */
interface Message {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: unknown;
}

/** 標準入出力で言語サーバーと JSON-RPC のメッセージを読み書きする。 */
class LanguageServer {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, (message: Message) => void>();
  private buffer = Buffer.alloc(0);
  private nextId = 0;

  constructor() {
    this.child = spawn(process.execPath, [tscBin, "--lsp", "--stdio"], { cwd: root });
    this.child.stdout!.on("data", (chunk: Buffer) => this.receive(chunk));
  }

  /** `method` のリクエストを送り、レスポンスの `result` を返す。 */
  async request(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.nextId;
    const response = new Promise<Message>((resolve) => this.pending.set(id, resolve));
    this.send({ jsonrpc: "2.0", id, method, params });
    const { result, error } = await response;
    if (error !== undefined) throw new Error(`${method}: ${JSON.stringify(error)}`);
    return result;
  }

  /** `method` の通知を送る。 */
  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** 言語サーバーに終了を求め、5 秒以内に shutdown に応答しないか、すでに終了していれば、プロセスを終了させる。 */
  async close(): Promise<void> {
    if (this.child.exitCode === null) {
      const exited = new Promise((resolve) => this.child.once("exit", resolve));
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise((resolve) => (timer = setTimeout(resolve, 5000)));
      await Promise.race([this.request("shutdown"), exited, timeout]);
      clearTimeout(timer);
      if (this.child.exitCode === null) this.notify("exit");
    }
    this.child.kill();
  }

  private send(message: object): void {
    const body = JSON.stringify(message);
    this.child.stdin!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(
        /Content-Length: (\d+)/i.exec(this.buffer.subarray(0, end).toString())?.[1],
      );
      if (this.buffer.length < end + 4 + length) return;
      const message = JSON.parse(
        this.buffer.subarray(end + 4, end + 4 + length).toString(),
      ) as Message;
      this.buffer = this.buffer.subarray(end + 4 + length);
      if (message.method === undefined && message.id !== undefined) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      } else if (message.id !== undefined) {
        // サーバーからのリクエスト（設定の取得など）には、空の結果を返す
        this.send({ jsonrpc: "2.0", id: message.id, result: null });
      }
    }
  }
}

let server: LanguageServer;

/** アプリのルートからの相対パス `file` の URI を返す。 */
const uriOf = (file: string) => pathToFileURL(join(root, file)).href;

/** 言語サーバーで開いたファイルである。 */
const opened = new Set<string>();

/** ファイル `file` を、まだ開いていなければ言語サーバーで開き、行の配列を返す。 */
function open(file: string): string[] {
  const text = readFileSync(join(root, file), "utf8");
  if (!opened.has(file)) {
    opened.add(file);
    server.notify("textDocument/didOpen", {
      textDocument: { uri: uriOf(file), languageId: "typescriptreact", version: 1, text },
    });
  }
  return text.split("\n");
}

/** 行の配列 `lines` の中で、`text` が最初に現れる行の、`text` の先頭から `offset` 文字目の位置を返す。 */
function positionOf(lines: readonly string[], text: string, offset = 0) {
  const line = lines.findIndex((content) => content.includes(text));
  if (line < 0) throw new Error(`${text} が見つかりません。`);
  return { line, character: lines[line]!.indexOf(text) + offset };
}

/** ファイル `file` の型の診断のメッセージを返す。 */
async function diagnostics(file: string): Promise<string[]> {
  open(file);
  const report = (await server.request("textDocument/diagnostic", {
    textDocument: { uri: uriOf(file) },
  })) as { items: { message: string }[] };
  return report.items.map((item) => item.message);
}

/** ファイル `file` の、`text` の先頭から `offset` 文字目の位置のホバーの文字列を返す。 */
async function hover(file: string, text: string, offset: number): Promise<string> {
  const lines = open(file);
  const result = (await server.request("textDocument/hover", {
    textDocument: { uri: uriOf(file) },
    position: positionOf(lines, text, offset),
  })) as { contents: { value: string } };
  return result.contents.value;
}

beforeAll(async () => {
  await run(process.execPath, [rinkaBin, "prepare", root]);
  server = new LanguageServer();
  await server.request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(root).href,
    capabilities: {
      textDocument: { diagnostic: {}, completion: {}, hover: { contentFormat: ["plaintext"] } },
    },
    workspaceFolders: [{ uri: pathToFileURL(root).href, name: "types" }],
  });
  server.notify("initialized", {});
}, 60_000);

afterAll(async () => {
  await server?.close();
});

/** ページの `<Counter ` の直後で補完したときの、候補のラベルを返す。 */
async function counterCompletions(): Promise<string[]> {
  const file = "src/routes/page.tsx";
  const lines = open(file);
  const result = (await server.request("textDocument/completion", {
    textDocument: { uri: uriOf(file) },
    position: positionOf(lines, "<Counter ", "<Counter ".length),
  })) as { items: { label: string }[] } | { label: string }[];
  return (Array.isArray(result) ? result : result.items).map((item) => item.label);
}

describe("言語サーバー", () => {
  it("要素とページのファイルを、それぞれのプロジェクトの型で検査し、_type-tests.tsx の @ts-expect-error がすべて有効になる", async () => {
    expect(await diagnostics("src/elements/_type-tests.tsx")).toEqual([]);
    expect(await diagnostics("src/elements/counter.tsx")).toEqual([]);
    expect(await diagnostics("src/routes/page.tsx")).toEqual([]);
  }, 60_000);

  it("ページで要素を記述すると、要素の props を補完する", async () => {
    expect(await counterCompletions()).toContain("start");
  }, 60_000);

  // TypeScript 7.1.0-beta の言語サーバーは load:* を補完しない
  it.fails("ページで要素を記述すると、load:* を補完する", async () => {
    expect(await counterCompletions()).toContain("load:idle?");
  }, 60_000);

  it("要素とサーバー関数のホバーに、型を表示する", async () => {
    expect(await hover("src/routes/page.tsx", "<Counter", 2)).toContain(
      "function Counter(props: Props",
    );
    expect(await hover("src/elements/counter.tsx", "await greet()", "await g".length)).toContain(
      "const greet: (input?: undefined, options?: CallOptions) => Promise<string>",
    );
  }, 60_000);
});
