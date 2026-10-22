/**
 * 起動スクリプトである。`window.$rinka` に受け口を定義する。既に `$rinka` があれば、保持している値を残して受け口を追加する。
 * `d(ホストの ID, 値のオブジェクト)` は、ホストに引き継ぐ値を保持して、待っている関数に通知する。
 * `r(spec)` は、1 つの境界の中身と、その境界の差し替えを適用する。開始と終了の目印がそろわない差し替えは、適用せずに除去する。
 * `n` は、memo の値が無いことを表すオブジェクトである。
 */
export const bootstrap = `<script>(R=>{window.$rinka=Object.assign(R,{v:R.v||{},l:R.l||{},n:R.n||{},
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
apply(s.b,s.bp,'template[data-os="'+s.b+'"]');for(const p of s.p)apply(p[0],p[1],'template[data-op="'+p[0]+'"]')}})})(window.$rinka||{})</script>`;
