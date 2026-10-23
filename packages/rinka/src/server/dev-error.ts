import { escapeText } from "./html.ts";
import { scriptJson } from "./script.ts";

/**
 * `error` を `console.error` で記録し、エラーのメッセージとスタックを Vite のエラーのオーバーレイで表示する、
 * HTML の 500 の Response を返す。
 */
export function devErrorResponse(error: unknown): Response {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  const payload = scriptJson({ message, stack });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Error</title><script type="module">import { ErrorOverlay } from "/@vite/client"; document.body.appendChild(new ErrorOverlay(${payload}));</script></head><body><pre>${escapeText(stack === "" ? message : stack)}</pre></body></html>`;
  return new Response(html, {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
