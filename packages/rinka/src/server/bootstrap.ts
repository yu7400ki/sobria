/**
 * 起動スクリプトである。`window.$rinka` に受け口を定義する。既に `$rinka` があれば、保持している値を残して受け口を追加する。
 * `d(ホストの ID, 値のオブジェクト)` は、ホストに引き継ぐ値を保持して、待っている関数に通知する。
 * `r(spec)` は、1 つの境界の中身と、その境界の差し替えを適用する。開始と終了の目印がそろわない差し替えは、適用せずに除去する。
 * `n` は、memo の値が無いことを表すオブジェクトである。
 * `m([[タグ名, モジュールの URL, デフォルトの起動タイミング], …])` は、要素の一覧を保持し、各要素の最初のインスタンスが起動の条件を満たした時点で、モジュールを 1 回だけ読み込む。
 * ドキュメントにあるインスタンスと、後から追加されたインスタンスを確認する。
 * `w(インスタンス, start)` は、インスタンスの `data-rinka-load` か、一覧のデフォルトの起動タイミングの条件を満たした時点で `start` を呼ぶ。一覧に無いタグなら、すぐに呼ぶ。
 */
export const bootstrap = `<script>(R=>{window.$rinka=Object.assign(R,{v:R.v||{},l:R.l||{},n:R.n||{},c:R.c||{},q:R.q||new WeakSet(),
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
k(el,t,f){const v=el.getAttribute('data-rinka-load')||t;
if(v==='idle')(window.requestIdleCallback||setTimeout)(()=>f());
else if(v==='visible'){const o=new IntersectionObserver(es=>{if(es.some(e=>e.isIntersecting)){o.disconnect();f()}});o.observe(el)}
else if(v.startsWith('media:')){const q=matchMedia(v.slice(6));if(q.matches)f();
else{const h=()=>{if(q.matches){q.removeEventListener('change',h);f()}};q.addEventListener('change',h)}}
else f()},
p(el){const e=this.c[el.localName];if(!e||e.s||this.q.has(el))return;this.q.add(el);
this.k(el,e.l,()=>{if(!e.s){e.s=1;import(e.u)}})},
s(root){for(const t in this.c)if(!this.c[t].s)for(const el of root.querySelectorAll(t))this.p(el)},
m(list){for(const[t,u,l]of list)this.c[t]||(this.c[t]={u,l,s:0});this.s(document);
if(!this.o){this.o=new MutationObserver(rs=>{for(const r of rs)for(const n of r.addedNodes)if(n.nodeType===1){this.p(n);this.s(n)}});
this.o.observe(document.documentElement,{childList:true,subtree:true})}},
w(el,f){const e=this.c[el.localName];e?this.k(el,e.l,f):f()}})})(window.$rinka||{})</script>`;
