import { describe, expect, it, vi } from "vitest";

import { devErrorResponse } from "../../src/server/internal.ts";

describe("開発中のエラーのページ", () => {
  it("エラーを記録し、メッセージとスタックを Vite のエラーのオーバーレイで表示する HTML の 500 を返す", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = new Error("</script><b>boom</b>");
      const response = devErrorResponse(error);
      expect(log).toHaveBeenCalledWith(error);
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await response.text();
      expect(html).toContain('import { ErrorOverlay } from "/@vite/client";');
      expect(html).toContain("&lt;/script&gt;&lt;b&gt;boom&lt;/b&gt;");
      expect(html).not.toContain("</script><b>");
      const json = /new ErrorOverlay\((.*)\)\);/.exec(html)![1]!;
      expect(JSON.parse(json)).toEqual({ message: error.message, stack: error.stack });
    } finally {
      log.mockRestore();
    }
  });

  it("Error でない値は、文字列にしてメッセージにする", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const html = await devErrorResponse("boom").text();
      const json = /new ErrorOverlay\((.*)\)\);/.exec(html)![1]!;
      expect(JSON.parse(json)).toEqual({ message: "boom", stack: "" });
    } finally {
      log.mockRestore();
    }
  });
});
