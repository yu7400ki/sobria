import { formMembers, lifecycleCallbacks } from "./host-members.ts";
import { structuralMembers } from "./structural-members.generated.ts";

/** `ctx.expose` で公開する名前を検査し、公開できない名前ならメッセージを返す。 */
export function checkExposeName(name: string, propNames: readonly string[]): string | undefined {
  const head = `"${name}" は expose で公開できません。`;
  if (
    (structuralMembers as readonly string[]).includes(name) ||
    (lifecycleCallbacks as readonly string[]).includes(name)
  ) {
    return `${head}rinka のランタイムとページの JS がホストを操作するときに、公開した値が使用されるためです。`;
  }
  if ((formMembers as readonly string[]).includes(name))
    return `${head}rinka がフォームへの参加に、この名前を使用するためです。`;
  if (propNames.includes(name))
    return `${head}公開した値が、同じ名前の props の値を上書きするためです。`;
  return undefined;
}
