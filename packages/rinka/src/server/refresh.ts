import type { RefreshPage } from "../shared/refresh.ts";

/** 呼び出すとエラーを投げる。 */
export const refreshPage: RefreshPage = () => {
  throw new Error("[rinka] refreshPage() は、ブラウザで呼び出してください。");
};
