import { loadTimings } from "../shared/names.ts";
import type { ListedElement, SwapSpec } from "../shared/receiver.ts";
import { scriptJson } from "./wire.ts";

/** インスタンスの起動のタイミングを指定する属性の名前である。 */
export const loadAttributeName = "data-rinka-load";

/** `load:media` を指定したインスタンスの、属性の値の接頭辞である。値はこの接頭辞とメディアクエリを連結したものである。 */
export const mediaPrefix = "media:";

/**
 * `<script>` で囲まない起動スクリプトである。`window.$rinka` に受け口を定義する。既に `$rinka` があれば、保持している値を残して受け口を追加する。
 * `d(ホストの ID, 値のオブジェクト)` は、ホストに引き継ぐ値を保持して、待っている関数に通知する。
 * `r(spec)` は、1 つの境界の中身と、その境界の差し替えを適用する。開始と終了の目印がそろわない差し替えは、適用せずに除去する。
 * `n` は、memo の値が無いことを表すオブジェクトである。
 * `m([[タグ名, モジュールの URL, デフォルトの起動タイミング], …])` は、要素の一覧を保持し、各要素の最初のインスタンスが起動の条件を満たした時点で、モジュールを 1 回だけ読み込む。
 * ドキュメントにあるインスタンスと、後から追加されたインスタンスを確認する。
 * `w(インスタンス, start)` は、インスタンスの起動のタイミングの属性か、一覧のデフォルトの起動タイミングの条件を満たした時点で `start` を呼ぶ。一覧に無いタグなら、すぐに呼ぶ。
 */
export const bootstrapSource = `(R=>{const E={},Q=new WeakSet();let O;
const when=(el,t,f)=>{const v=el.getAttribute('${loadAttributeName}')||t;
if(v==='idle')(window.requestIdleCallback||setTimeout)(()=>f());
else if(v==='visible'){const o=new IntersectionObserver(es=>{if(es.some(e=>e.isIntersecting)){o.disconnect();f()}});o.observe(el)}
else if(v.startsWith('${mediaPrefix}')){const q=matchMedia(v.slice(${mediaPrefix.length}));if(q.matches)f();
else{const h=()=>{if(q.matches){q.removeEventListener('change',h);f()}};q.addEventListener('change',h)}}
else f()};
const watch=el=>{const e=E[el.localName];if(!e||e.s||Q.has(el))return;Q.add(el);
when(el,e.l,()=>{if(!e.s){e.s=1;import(e.u)}})};
const scan=root=>{for(const t in E)if(!E[t].s)for(const el of root.querySelectorAll(t))watch(el)};
window.$rinka=Object.assign(R,{v:R.v||{},l:R.l||{},n:R.n||{},
d(id,o){Object.assign(this.v[id]||(this.v[id]={}),o);(this.l[id]||[]).slice().forEach(f=>f())},
r(s){const me=document.currentScript;me&&me.remove();
const fix=root=>{for(const t of root.querySelectorAll('template[shadowrootmode]')){fix(t.content);const host=t.parentElement;
if(host&&!host.shadowRoot){host.attachShadow({mode:t.getAttribute('shadowrootmode')}).append(t.content);t.remove()}}};
const apply=(id,path,holder)=>{const src=document.querySelector(holder);let root=document;
for(const h of path){const el=root&&root.querySelector('[data-oh="'+h+'"]');root=el&&el.shadowRoot}
const start=root&&root.querySelector('template[data-ob="'+id+'"]');let end=start&&start.nextSibling;
while(end&&!(end.nodeType===8&&end.data==='/ob:'+id))end=end.nextSibling;
if(!src)return;if(!end){src.remove();return}
while(start.nextSibling!==end)start.nextSibling.remove();
fix(src.content);end.parentNode.insertBefore(src.content,end);start.remove();end.remove();src.remove()};
apply(s.b,s.bp,'template[data-os="'+s.b+'"]');for(const p of s.p)apply(p[0],p[1],'template[data-op="'+p[0]+'"]')},
m(list){for(const[t,u,l]of list)E[t]||(E[t]={u,l,s:0});scan(document);
if(!O){O=new MutationObserver(rs=>{for(const r of rs)for(const n of r.addedNodes)if(n.nodeType===1){watch(n);scan(n)}});
O.observe(document.documentElement,{childList:true,subtree:true})}},
w(el,f){const e=E[el.localName];e?when(el,e.l,f):f()}})})(window.$rinka||{})`;

/** `<script>` で囲んだ起動スクリプトである。 */
export const bootstrap = `<script>${bootstrapSource}</script>`;

/** 値が無いことを表す JS の式である。 */
export const noValue = "$rinka.n";

/** JS の式 `value` を、ID が `id` のホストの `key` の値として送るスクリプトを返す。 */
export const dataScript = (id: string, key: string, value: string): string =>
  `<script>$rinka.d(${scriptJson(id)},{${scriptJson(key)}:${value}})</script>`;

/** 要素の一覧を起動スクリプトに伝えるスクリプトを返す。一覧が空なら空の文字列を返す。 */
export const listScript = (list: readonly ListedElement[]): string =>
  list.length === 0 ? "" : `<script>$rinka.m(${scriptJson(list)})</script>`;

/** 1 つの境界の中身と、その境界の中の差し替えを適用するスクリプトを返す。 */
export const swapScript = (spec: SwapSpec): string =>
  `<script>$rinka.r(${scriptJson(spec)})</script>`;

/**
 * 要素の props の `load:*` から、起動のタイミングの属性の値を返す。`load:media` は、`media:` にメディアクエリを連結する。
 * 名前が `loadTimings` に含まれる `load:*` が無ければ `undefined` を返す。
 */
export function loadAttributeValue(props: Record<string, unknown>): string | undefined {
  for (const name of Object.keys(props)) {
    const timing = loadTimings.find((candidate) => name === `load:${candidate}`);
    if (timing === undefined) continue;
    return timing === "media" ? `${mediaPrefix}${String(props[name])}` : timing;
  }
  return undefined;
}
