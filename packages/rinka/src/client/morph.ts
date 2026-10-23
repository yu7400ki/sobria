/** `<script>` か `<template>` であるかを返す。 */
const isKept = (node: Node): boolean =>
  node instanceof HTMLScriptElement || node instanceof HTMLTemplateElement;

/** `data-ok` のキーを返す。 */
const keyOf = (node: Node): string | null =>
  node instanceof Element ? node.getAttribute("data-ok") : null;

/** `from` を `to` に合わせて使用し続けられるかを返す。 */
const sameKind = (from: Node, to: Node): boolean =>
  from.nodeType === to.nodeType &&
  (!(from instanceof Element) || (to instanceof Element && from.tagName === to.tagName));

/**
 * `parent` の子を、`html` を解析した子に合わせる。
 * ページにある `<script>` と `<template>` は残し、`html` からは `<script>` と `<template>` を除いてから合わせる。
 * 使用し続ける要素のホストは属性を変更せずに Light DOM の子だけを合わせ、`html` でのホストの ID とともに `onHost` に渡す。
 */
export function morph(
  parent: Element,
  html: string,
  onHost: (host: Element, id: string) => void,
): void {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const kept of template.content.querySelectorAll("script, template")) kept.remove();
  morphChildren(parent, template.content, onHost);
}

/** `parent` の子を、`source` の子に合わせる。 */
function morphChildren(
  parent: Node,
  source: Node,
  onHost: (host: Element, id: string) => void,
): void {
  const candidates = [...parent.childNodes].filter((node) => !isKept(node));
  const keyed = new Map<string, Node>();
  const unkeyed: Node[] = [];
  for (const node of candidates) {
    const key = keyOf(node);
    if (key === null) unkeyed.push(node);
    else keyed.set(key, node);
  }
  let position = 0;
  const result: Node[] = [];
  for (const node of source.childNodes) {
    const key = keyOf(node);
    let match: Node | undefined;
    if (key === null) {
      match = unkeyed[position];
      position += 1;
    } else {
      match = keyed.get(key);
      keyed.delete(key);
    }
    if (match !== undefined && sameKind(match, node)) {
      update(match, node, onHost);
      result.push(match);
    } else {
      result.push(node);
    }
  }
  const used = new Set(result);
  for (const node of candidates) if (!used.has(node)) node.remove();
  let next = parent.firstChild;
  for (const node of result) {
    while (next !== null && isKept(next)) next = next.nextSibling;
    if (next === node) next = node.nextSibling;
    else parent.insertBefore(node, next);
  }
}

/** 使用し続ける `node` を、`source` に合わせる。 */
function update(node: Node, source: Node, onHost: (host: Element, id: string) => void): void {
  if (!(node instanceof Element) || !(source instanceof Element)) {
    if (node.nodeValue !== source.nodeValue) node.nodeValue = source.nodeValue;
    return;
  }
  const host = node.hasAttribute("data-oh") ? source.getAttribute("data-oh") : null;
  if (host === null) syncAttributes(node, source);
  else onHost(node, host);
  morphChildren(node, source, onHost);
}

/** `element` の属性を、`source` の属性に合わせる。 */
function syncAttributes(element: Element, source: Element): void {
  for (const { namespaceURI, localName } of Array.from(element.attributes)) {
    if (!source.hasAttributeNS(namespaceURI, localName)) {
      element.removeAttributeNS(namespaceURI, localName);
    }
  }
  for (const { namespaceURI, localName, name, value } of source.attributes) {
    if (element.getAttributeNS(namespaceURI, localName) !== value) {
      element.setAttributeNS(namespaceURI, name, value);
    }
  }
}
