/** sobria がフォームの部品のホストに付与する API の名前を列挙する。 */
export const formMembers = [
  "form",
  "labels",
  "validity",
  "validationMessage",
  "willValidate",
  "checkValidity",
  "reportValidity",
] as const;

/** Custom Element のライフサイクルのコールバックの名前を列挙する。 */
export const lifecycleCallbacks = [
  "connectedCallback",
  "disconnectedCallback",
  "adoptedCallback",
  "attributeChangedCallback",
  "connectedMoveCallback",
  "formAssociatedCallback",
  "formResetCallback",
  "formDisabledCallback",
  "formStateRestoreCallback",
] as const;
