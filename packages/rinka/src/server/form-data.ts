/** 名前の区切りのうち、配列に要素を追加する `[]` を表す。 */
const append = Symbol("append");

type Segment = string | number | typeof append;

/** 名前の区切りに含むと、フィールドを捨てる語である。 */
const forbidden = new Set(["__proto__", "constructor", "prototype"]);

/** 位置に置く値の形を表す。`leaf` は値で、`list` は `[]` の配列、`array` は添字の配列、`object` はオブジェクトである。 */
type Form = "leaf" | "list" | "array" | "object";

/**
 * フォームのフィールドを、名前の構造に従って入力のオブジェクトにする。
 * `.` はオブジェクトに、`[数]` は配列に、`[]` はフィールドごとに要素を追加する配列にする。同じ名前の繰り返しは配列にする。
 * 値は文字列か File のまま渡す。名前の区切りに `__proto__`、`constructor`、`prototype` を含むフィールドと、
 * それまでと異なる形で同じ位置を使用するフィールドと、それまでの要素の数より大きい添字のフィールドは捨てる。
 */
export function formDataToInput(form: FormData): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const forms = new Map<string, Form>();
  for (const [name, value] of form) {
    const path = segments(name);
    if (path.some((segment) => typeof segment === "string" && forbidden.has(segment))) continue;
    assign(root, path, value, forms);
  }
  return root;
}

/** フィールドの名前を区切りの列にする。構造として解釈できなければ、名前の全体を 1 つの区切りにする。 */
function segments(name: string): Segment[] {
  const match = /^([^.[\]]+)((?:\.[^.[\]]+|\[\d*\])*)$/.exec(name);
  if (!match?.[1]) return [name];
  const path: Segment[] = [match[1]];
  for (const [, key, index] of (match[2] ?? "").matchAll(/\.([^.[\]]+)|\[(\d*)\]/g)) {
    if (key !== undefined) path.push(key);
    else path.push(index === "" || index === undefined ? append : Number(index));
  }
  return path;
}

/** 区切りの次の区切りから、その位置に置く値の形を返す。 */
const formOf = (next: Segment | undefined): Form =>
  next === undefined
    ? "leaf"
    : next === append
      ? "list"
      : typeof next === "number"
        ? "array"
        : "object";

function assign(
  root: Record<string, unknown>,
  path: readonly Segment[],
  value: FormDataEntryValue,
  forms: Map<string, Form>,
): void {
  let container: Record<string, unknown> | unknown[] = root;
  let key = "";
  for (const [index, segment] of path.entries()) {
    key += `\u0000${String(segment)}`;
    const form = formOf(path[index + 1]);
    const known = forms.get(key);
    if (known !== undefined && known !== form) return;
    forms.set(key, form);
    const slot = place(container, segment);
    if (slot === undefined) return;
    if (form === "leaf") {
      const current = slot.get();
      if (current === undefined) slot.set(value);
      else if (Array.isArray(current)) current.push(value);
      else slot.set([current, value]);
      return;
    }
    let next = slot.get();
    if (next === undefined) {
      next = form === "object" ? {} : [];
      slot.set(next);
    }
    if (!isContainer(next)) return;
    container = next;
  }
}

/** `value` が、入力の構造として作成したオブジェクトか配列かどうかを返す。 */
const isContainer = (value: unknown): value is Record<string, unknown> | unknown[] =>
  typeof value === "object" && value !== null && !(value instanceof File);

/** `container` の中で `segment` が指す位置の読み書きを返す。位置を作れなければ `undefined` を返す。 */
function place(
  container: Record<string, unknown> | unknown[],
  segment: Segment,
): { get: () => unknown; set: (value: unknown) => void } | undefined {
  if (Array.isArray(container)) {
    if (segment === append) {
      const at = container.length;
      return { get: () => container[at], set: (value) => container.push(value) };
    }
    if (typeof segment !== "number" || segment > container.length) return undefined;
    return { get: () => container[segment], set: (value) => (container[segment] = value) };
  }
  if (typeof segment !== "string") return undefined;
  return {
    get: () => (Object.hasOwn(container, segment) ? container[segment] : undefined),
    set: (value) => (container[segment] = value),
  };
}
