import { bindRules, loadPandaProject } from "@pandacss/eslint-plugin";

const { linter, project } = await loadPandaProject({ cwd: import.meta.dirname });

/** Panda CSS の設定に結び付けた規則を、規則の名前の接頭辞 `@pandacss` で公開する。 */
export default { meta: { name: "@pandacss" }, rules: bindRules(linter, project) };
