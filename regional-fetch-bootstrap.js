const { URL } = require('url');
const Module = require('module');
const fs = require('fs');

const originalFetch = global.fetch;
const originalReadFileSync = fs.readFileSync.bind(fs);

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-+$/g, '');
}

function cityFromNieruchomosciUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!/^(www\.)?nieruchomosci-online\.pl$/i.test(u.hostname)) return '';
    const raw = decodeURIComponent(u.search || '');
    const match = raw.match(/,,([^,:&]+)(?::\d+)?(?:,|&|$)/i);
    return match ? String(match[1]).trim() : '';
  } catch (_) {
    return '';
  }
}

function regionalUrl(rawUrl, city) {
  const slug = slugify(city);
  if (!slug) return null;
  const u = new URL(rawUrl);
  u.hostname = `${slug}.nieruchomosci-online.pl`;
  return u.href;
}

global.fetch = async function patchedFetch(input, init) {
  const raw = typeof input === 'string' ? input : input?.url;
  const city = cityFromNieruchomosciUrl(raw);
  if (!city) return originalFetch(input, init);
  const target = regionalUrl(raw, city);
  if (!target) return originalFetch(input, init);
  try {
    const regional = await originalFetch(target, init);
    if (regional.ok || regional.status === 304) return regional;
    if (regional.status >= 400) return originalFetch(raw, init);
    return regional;
  } catch (_) {
    return originalFetch(raw, init);
  }
};

const uiPatch = `<script>(function(){function reconcile(){try{var d=window.lastData||{},p=document.getElementById('propertyType'),isPlot=String(p&&p.value||d.propertyType||'').toLowerCase().includes('dział')||String(p&&p.value||d.propertyType||'').toLowerCase().includes('dzial');var pill=document.querySelector('.section-title .pill');if(pill&&!pill.classList.contains('source-switcher'))pill.textContent=isPlot?'5 źródeł danych':'6 źródeł danych';var f=Number(d.beforeCrossDedup);if(!Number.isFinite(f)){f=(d.sources||[]).reduce(function(a,s){return a+Number(s.filtered||0)},0)}var dup=Number(d.duplicatesRemoved);if(!Number.isFinite(dup))dup=0;var acc=Number(d.unique);if(!Number.isFinite(acc))acc=Array.isArray(d.offers)?d.offers.length:0;var fe=document.getElementById('filtered'),de=document.getElementById('duplicates'),ae=document.getElementById('accepted');if(fe)fe.textContent=Number(f).toLocaleString('pl-PL');if(de)de.textContent=Number(dup).toLocaleString('pl-PL');if(ae)ae.textContent=Number(acc).toLocaleString('pl-PL');var table=document.querySelector('#offers table.offers');if(!table)return;var head=table.tHead&&table.tHead.rows[0];if(head&&!head.querySelector('.lp-head')){var th=document.createElement('th');th.className='lp-head';th.textContent='LP';head.insertBefore(th,head.firstChild)}var rows=table.tBodies[0]?table.tBodies[0].rows:[];for(var i=0;i<rows.length;i++){if(!rows[i].querySelector('.lp-cell')){var td=document.createElement('td');td.className='lp-cell';td.textContent=String(i+1);rows[i].insertBefore(td,rows[i].firstChild)}}}catch(e){}}var obs=new MutationObserver(reconcile);document.addEventListener('DOMContentLoaded',function(){reconcile();var r=document.getElementById('results');if(r)obs.observe(r,{childList:true,subtree:true});var p=document.getElementById('propertyType');if(p)p.addEventListener('change',function(){setTimeout(reconcile,0)})});window.addEventListener('load',reconcile);})();</script>`;

const portalFilterPatch = `<script>(function(){
  const state={enabled:new Set(),all:[],data:null};
  const $=id=>document.getElementById(id);
  const esc=v=>String(v??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]||c));
  function portalName(s){return String(s?.portal||s?.source||'Źródło').trim()||'Źródło'}
  function normalizeUrl(value){try{const u=new URL(value);u.hash='';u.search='';return u.href.replace(/\/$/,'').toLowerCase()}catch{return String(value||'').trim().toLowerCase().replace(/\/$/,'')}}
  function dedupe(offers){const seenUrl=new Set(),seenData=new Set(),rows=[],duplicates=[];for(const offer of offers||[]){const urlKey=normalizeUrl(offer?.url),price=Number(offer?.price),area=Number(offer?.area),dataKey=Number.isFinite(price)&&Number.isFinite(area)?`${price}|${area}`:'';let reason='';if(urlKey&&seenUrl.has(urlKey))reason='ten sam URL';else if(dataKey&&seenData.has(dataKey))reason='ta sama cena + ta sama powierzchnia';if(reason){const kept=rows.find(x=>(urlKey&&normalizeUrl(x.url)===urlKey)||(dataKey&&`${Number(x.price)}|${Number(x.area)}`===dataKey));duplicates.push({reason,kept:kept||rows[0],duplicate:offer});continue}if(urlKey)seenUrl.add(urlKey);if(dataKey)seenData.add(dataKey);rows.push(offer)}return{rows,duplicates}}
  function rebuild(){
    const base=state.data;if(!base)return;
    const active=state.all.filter(s=>state.enabled.has(portalName(s)));
    const before=active.flatMap(s=>Array.isArray(s.offers)?s.offers:[]),cross=dedupe(before);
    const byPortal={};
    active.forEach(s=>{const n=portalName(s);byPortal[n]={...(byPortal[n]||{filtered:0,internal:0,external:0,accepted:0}),filtered:Array.isArray(s.offers)?s.offers.length:Number(s.filtered||0)}});
    cross.duplicates.forEach(d=>{const dup=portalName(d.duplicate),kept=portalName(d.kept);if(!byPortal[dup])byPortal[dup]={filtered:0,internal:0,external:0,accepted:0};if(dup===kept)byPortal[dup].internal++;else byPortal[dup].external++});
    const sources=state.all.map(s=>{const n=portalName(s),x=byPortal[n];if(!x)return{...s,filtered:0,offers:[],internalDuplicatesRemoved:0,externalDuplicatesRemoved:0,duplicatesRemoved:0,acceptedAfterDedup:0,disabled:true};return{...s,filtered:x.filtered,offers:Array.isArray(s.offers)?s.offers:[],internalDuplicatesRemoved:x.internal,externalDuplicatesRemoved:x.external,duplicatesRemoved:x.internal+x.external,acceptedAfterDedup:Math.max(0,x.filtered-x.internal-x.external),disabled:false}});
    const next={...base,sources,offers:cross.rows,beforeCrossDedup:before.length,unique:cross.rows.length,duplicatesRemoved:cross.duplicates.length,duplicates:cross.duplicates};
    state.data=next;window.lastData=next;currentOffers=cross.rows;originalRender(next);
    updateSourcesUI();
  }
  function updateSourcesUI(){
    const pill=document.querySelector('.search-grid')?.parentElement?.querySelector('.section-title .pill')||document.querySelector('.section-title .pill');
    if(pill){const total=state.all.length,active=state.enabled.size;pill.textContent=active===total?`${total} źródeł danych`:`${active}/${total} źródeł danych`;pill.classList.add('source-switcher');pill.title='Kliknij, aby wybrać portale';}
    const box=$('portalSelector');if(!box)return;
    box.querySelectorAll('input[type=checkbox]').forEach(cb=>{cb.checked=state.enabled.has(cb.value)});
    box.querySelectorAll('.portal-row').forEach(row=>row.classList.toggle('disabled',!state.enabled.has(row.dataset.portal)));
    document.querySelectorAll('#sources .source').forEach((card,i)=>{const s=state.all[i],disabled=s&&!state.enabled.has(portalName(s));card.classList.toggle('disabled-source',!!disabled);let tag=card.querySelector('.source-disabled-label');if(disabled&&!tag){tag=document.createElement('span');tag.className='source-disabled-label';tag.textContent='Wyłączone z analizy';card.querySelector('h3')?.appendChild(tag)}if(!disabled&&tag)tag.remove()});
  }
  function close(){const box=$('portalSelector');if(box)box.classList.remove('open')}
  function buildSelector(){
    if($('portalSelector'))return;
    const pill=document.querySelector('.search-grid')?.parentElement?.querySelector('.section-title .pill')||document.querySelector('.section-title .pill');if(!pill)return;
    const box=document.createElement('div');box.id='portalSelector';box.className='portal-selector';
    box.innerHTML='<div class="portal-selector-title"><strong>Źródła danych</strong><span>Wybierz portale używane w analizie</span></div><div class="portal-list"></div>';
    document.body.appendChild(box);
    pill.classList.add('source-switcher');pill.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();const r=pill.getBoundingClientRect();box.style.top=(r.bottom+8+window.scrollY)+'px';box.style.left=Math.max(12,Math.min(window.innerWidth-300,r.right-288))+'px';box.classList.toggle('open')});
    document.addEventListener('click',e=>{if(!e.target.closest('#portalSelector')&&!e.target.closest('.source-switcher'))close()});
  }
  function populate(){
    buildSelector();const list=$('portalSelector')?.querySelector('.portal-list');if(!list)return;
    list.innerHTML=state.all.map(s=>{const n=portalName(s);return `<label class="portal-row" data-portal="${esc(n)}"><input type="checkbox" value="${esc(n)}"><span>${esc(n)}</span></label>`}).join('');
    list.querySelectorAll('input').forEach(cb=>cb.addEventListener('change',()=>{if(cb.checked)state.enabled.add(cb.value);else state.enabled.delete(cb.value);rebuild()}));
    updateSourcesUI();
  }
  const originalRender=window.render;
  window.render=function(data){
    originalRender(data);
    state.data=window.lastData||data;state.all=Array.isArray(data?.sources)?data.sources:[];state.enabled=new Set(state.all.map(portalName));populate();updateSourcesUI();
  };
  function css(){if(document.getElementById('portal-selector-style'))return;const s=document.createElement('style');s.id='portal-selector-style';s.textContent='.source-switcher{cursor:pointer;user-select:none}.source-switcher:hover{border-color:var(--accent);filter:brightness(1.08)}.portal-selector{position:absolute;z-index:1000;width:288px;background:#10233b;border:1px solid #36506e;border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.4);padding:12px;display:none}.portal-selector.open{display:block}.portal-selector-title{display:flex;flex-direction:column;gap:2px;padding:2px 4px 9px;border-bottom:1px solid #29415e;margin-bottom:6px}.portal-selector-title strong{font-size:14px}.portal-selector-title span{font-size:11px;color:#9db0c7}.portal-list{display:flex;flex-direction:column;gap:2px}.portal-row{display:flex;align-items:center;gap:9px;padding:9px 7px;border-radius:8px;cursor:pointer;color:#eef4fb}.portal-row:hover{background:#193451}.portal-row.disabled{color:#71859c;opacity:.75}.portal-row input{accent-color:#25e0c4;width:16px;height:16px;margin:0}.source.disabled-source{opacity:.55;filter:saturate(.5)}.source.disabled-source h3{color:#71859c}.source-disabled-label{display:inline-block;margin-left:6px;padding:2px 6px;border:1px solid #36506e;border-radius:999px;font-size:10px;color:#9db0c7}';document.head.appendChild(s)}
  document.addEventListener('DOMContentLoaded',()=>{css();buildSelector()});window.addEventListener('load',()=>{css();buildSelector()});
})();</script>`;

fs.readFileSync = function patchedReadFileSync(file, options) {
  const out = originalReadFileSync(file, options);
  if (typeof file === 'string' && /(?:^|[\\/])index\.html$/i.test(file) && typeof out === 'string') {
    return out.includes('</body>') ? out.replace('</body>', uiPatch + portalFilterPatch + '</body>') : out + uiPatch + portalFilterPatch;
  }
  return out;
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(request) {
  if (request === './live-combined-api-v05' && /compat-server\.js$/i.test(this.filename || '')) {
    return originalRequire.call(this, './live-combined-with-counts');
  }
  return originalRequire.apply(this, arguments);
};

console.log('REGIONAL N-O FETCH ENABLED');
console.log('COMBINED PORTAL COUNTS ENABLED');
console.log('UI RESULT COUNTERS + LP ENABLED');
console.log('UI PORTAL SELECTOR ENABLED');
require('./compat-server');
