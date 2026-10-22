/**
 * ページの `<head>` に出力する起動スクリプト。`window.$rinka` に受け口を定義する。既に `$rinka` があれば、受け口を追加する。
 * `d(ホストの ID, 値)` はホストに引き継ぐ値を保持して、待っている関数に知らせる。`r(spec)` は 1 つの境界の差し替えの集合を適用する。
 */
export const bootstrap = `<script>window.$rinka=Object.assign(window.$rinka||{},{v:{},l:{},
d(id,o){Object.assign(this.v[id]||(this.v[id]={}),o);(this.l[id]||[]).slice().forEach(f=>f())},
r(s){const me=document.currentScript;me&&me.remove();
const holders=['template[data-os="'+s.b+'"]'].concat(s.p.map(p=>'template[data-op="'+p[0]+'"]'));
const fix=root=>{for(const t of root.querySelectorAll('template[shadowrootmode]')){fix(t.content);const host=t.parentElement;
if(host&&!host.shadowRoot){host.attachShadow({mode:t.getAttribute('shadowrootmode')}).append(t.content);t.remove()}}};
const apply=(id,path,holder)=>{let root=document;for(const h of path){const el=root&&root.querySelector('[data-oh="'+h+'"]');root=el&&el.shadowRoot}
const start=root&&root.querySelector('template[data-ob="'+id+'"]');const src=document.querySelector(holder);if(!start||!src)return;
let n=start.nextSibling;while(n&&!(n.nodeType===8&&n.data==='/ob:'+id)){const x=n.nextSibling;n.remove();n=x}
if(!n)return;fix(src.content);n.parentNode.insertBefore(src.content,n);start.remove();n.remove();src.remove()};
apply(s.b,s.bp,holders[0]);s.p.forEach((p,i)=>apply(p[0],p[1],holders[i+1]));
for(const h of s.h)this.d(h,{['@'+s.b]:1})}})</script>`;
