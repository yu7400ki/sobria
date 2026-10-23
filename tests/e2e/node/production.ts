import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";

import { rinka, type RinkaOptions } from "rinka/vite";
import { createBuilder, type PluginOption } from "vite";

/** 本番のビルドでの、ファイル `file` のサーバー関数 `name` の RPC のパスを返す。 */
export const rpcPath = (file: string, name: string) => {
  const module = `m${createHash("sha256").update(file).digest("base64url").slice(0, 10)}`;
  return `/_rinka/fn/${encodeURIComponent(`${module}#${name}`)}`;
};

/** テスト用のアプリのルート `root` を、rinka のプラグイン（接頭辞は `app`）と `plugins` で `outDir` にビルドする。 */
export async function buildFixture(
  root: string,
  outDir: string,
  options: RinkaOptions = {},
  plugins: PluginOption[] = [],
): Promise<void> {
  const builder = await createBuilder({
    root,
    configFile: false,
    logLevel: "error",
    plugins: [rinka({ prefix: "app", outDir, ...options }), ...plugins],
  });
  await builder.buildApp();
}

/** 使用されていないポートの番号を返す。 */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** オリジン `origin` のサーバーが応答するまで、100ms ごとに最大 `attempts` 回試す。 */
async function waitFor(origin: string, attempts = 100): Promise<void> {
  try {
    await fetch(origin);
  } catch {
    if (attempts === 0) throw new Error(`${origin} が応答しません。`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await waitFor(origin, attempts - 1);
  }
}

/** 起動したサーバーのオリジンと、サーバーを停止する関数を表す。 */
export interface RunningServer {
  readonly origin: string;
  readonly stop: () => void;
}

/** `command` でサーバーのエントリー `index` を、使用されていないポートで起動し、応答するまで待つ。 */
export async function startServer(command: string, index: string): Promise<RunningServer> {
  const port = await freePort();
  const child = spawn(command, [index], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  const origin = `http://localhost:${port}`;
  try {
    await waitFor(origin);
  } catch (error) {
    child.kill();
    throw error;
  }
  return { origin, stop: () => child.kill() };
}
