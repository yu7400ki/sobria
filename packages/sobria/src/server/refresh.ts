import type { RefreshPage } from "../shared/refresh.ts";

/** エラーで reject する Promise を返す。 */
export const refreshPage: RefreshPage = () =>
  Promise.reject(new Error("[sobria] refreshPage() は、ブラウザで呼び出してください。"));
