import {
  BOUNDARY_ATTRIBUTE,
  BOUNDARY_END,
  BOUNDARY_CONTENT_ATTRIBUTE,
  HOST_ATTRIBUTE,
  LOAD_ATTRIBUTE,
  PATCH_ATTRIBUTE,
} from "../shared/attributes.ts";
import { loadTimings } from "../shared/names.ts";
import type { ListedElement, SwapSpec } from "../shared/receiver.ts";
import { serverFnRefName } from "../shared/server-fn.ts";
import { scriptJson } from "./script.ts";

/** `load:media` を指定したインスタンスの、属性の値の接頭辞である。値はこの接頭辞とメディアクエリを連結したものである。 */
export const mediaPrefix = "media:";

/** `<script>` で囲まない起動スクリプトである。`window.$rinka` に `Receiver` の受け口を定義する。既に `$rinka` があれば、保持している値を残して受け口を追加する。 */
export const bootstrapSource = `(R=>{const E={},Q=new WeakSet(),C={};let O,P;
const when=(el,t,f)=>{const v=el.getAttribute('${LOAD_ATTRIBUTE}')||t;
if(v==='idle')(window.requestIdleCallback||setTimeout)(()=>f());
else if(v==='visible'){const o=new IntersectionObserver(es=>{if(es.some(e=>e.isIntersecting)){o.disconnect();f()}});o.observe(el)}
else if(v.startsWith('${mediaPrefix}')){const q=matchMedia(v.slice(${mediaPrefix.length}));if(q.matches)f();
else{const h=()=>{if(q.matches){q.removeEventListener('change',h);f()}};q.addEventListener('change',h)}}
else f()};
const watch=el=>{const e=E[el.localName];if(!e||e.s||Q.has(el))return;Q.add(el);
when(el,e.l,()=>{if(!e.s){e.s=1;import(e.u)}})};
const scan=root=>{for(const t in E)if(!E[t].s)for(const el of root.querySelectorAll(t))watch(el)};
const F={};
window.$rinka=Object.assign(R,{v:R.v||{},l:R.l||{},n:R.n||{},t:R.t||new WeakSet(),c:R.c,
s(v){const x={v};this.t.add(x);return x},
f(id,m){const k=m+' '+id;return F[k]||(F[k]=Object.defineProperty((...a)=>this.c(id,m)(...a),Symbol.for(${scriptJson(serverFnRefName)}),{value:{id,method:m}}))},
d(id,o){Object.assign(this.v[id]||(this.v[id]={}),o);(this.l[id]||[]).slice().forEach(f=>f())},
r(s){const me=document.currentScript;me&&me.remove();
const fix=root=>{for(const t of root.querySelectorAll('template[shadowrootmode]')){fix(t.content);const host=t.parentElement;
if(host&&!host.shadowRoot){host.attachShadow({mode:t.getAttribute('shadowrootmode'),delegatesFocus:t.hasAttribute('shadowrootdelegatesfocus')}).append(t.content);t.remove()}}};
const apply=(id,path,holder)=>{const src=document.querySelector(holder);let root=document;
for(const h of path){const el=root&&root.querySelector('[${HOST_ATTRIBUTE}="'+h+'"]');root=el&&el.shadowRoot}
const start=root&&root.querySelector('template[${BOUNDARY_ATTRIBUTE}="'+id+'"]');let end=start&&start.nextSibling;
while(end&&!(end.nodeType===8&&end.data==='${BOUNDARY_END}'+id))end=end.nextSibling;
if(!src)return;if(!end){src.remove();return}
while(start.nextSibling!==end)start.nextSibling.remove();
fix(src.content);end.parentNode.insertBefore(src.content,end);start.remove();end.remove();src.remove()};
const hs=[[s.b,s.bp,'template[${BOUNDARY_CONTENT_ATTRIBUTE}="'+s.b+'"]'],...s.p.map(p=>[p[0],p[1],'template[${PATCH_ATTRIBUTE}="'+p[0]+'"]'])];
const run=()=>{for(const h of hs)apply(...h)};const w=[];
const find=root=>{for(const l of root.querySelectorAll('link[rel="stylesheet"]')){const u=new URL(l.getAttribute('href'),document.baseURI).href;
if(C[u]!==1)w.push(C[u]||(C[u]=new Promise(f=>{const k=document.createElement('link');k.rel='preload';k.as='style';k.href=u;
k.onload=k.onerror=()=>{C[u]=1;f()};document.head.append(k)})))}
for(const t of root.querySelectorAll('*'))t.content?find(t.content):t.shadowRoot&&find(t.shadowRoot)};
for(const h of hs){const t=document.querySelector(h[2]);t&&find(t.content)}
if(!P&&!w.length){run();return}
const q=(P||Promise.resolve()).then(()=>Promise.all(w)).then(run).catch(e=>{setTimeout(()=>{throw e})});P=q;q.then(()=>{if(P===q)P=undefined})},
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

/** JS の式 `value` を最初の値にするストリームを作成する JS の式を返す。 */
export const streamExpression = (value: string): string => `$rinka.s(${value})`;

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

/** サーバー関数の代わりの関数を作る、`$rinka.f` の式を返す。`id` と `method` は、ID とメソッドの文字列を作る JS の式である。 */
export const serverFnCall = (id: string, method: string): string => `$rinka.f(${id},${method})`;
