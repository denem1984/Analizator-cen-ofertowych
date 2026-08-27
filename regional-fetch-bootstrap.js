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

const uiPatch = `<script>(function(){function reconcile(){try{var d=window.lastData||{},p=document.getElementById('propertyType'),isPlot=String(p&&p.value||d.propertyType||'').toLowerCase().includes('dział')||String(p&&p.value||d.propertyType||'').toLowerCase().includes('dzial');var pill=document.querySelector('.section-title .pill');if(pill)pill.textContent=isPlot?'5 źródeł danych':'6 źródeł danych';var f=Number(d.beforeCrossDedup);if(!Number.isFinite(f)){f=(d.sources||[]).reduce(function(a,s){return a+Number(s.filtered||0)},0)}var dup=Number(d.duplicatesRemoved);if(!Number.isFinite(dup))dup=0;var acc=Number(d.unique);if(!Number.isFinite(acc))acc=Array.isArray(d.offers)?d.offers.length:0;var fe=document.getElementById('filtered'),de=document.getElementById('duplicates'),ae=document.getElementById('accepted');if(fe)fe.textContent=Number(f).toLocaleString('pl-PL');if(de)de.textContent=Number(dup).toLocaleString('pl-PL');if(ae)ae.textContent=Number(acc).toLocaleString('pl-PL');var table=document.querySelector('#offers table.offers');if(!table)return;var head=table.tHead&&table.tHead.rows[0];if(head&&!head.querySelector('.lp-head')){var th=document.createElement('th');th.className='lp-head';th.textContent='LP';head.insertBefore(th,head.firstChild)}var rows=table.tBodies[0]?table.tBodies[0].rows:[];for(var i=0;i<rows.length;i++){if(!rows[i].querySelector('.lp-cell')){var td=document.createElement('td');td.className='lp-cell';td.textContent=String(i+1);rows[i].insertBefore(td,rows[i].firstChild)}}}catch(e){}}var obs=new MutationObserver(reconcile);document.addEventListener('DOMContentLoaded',function(){reconcile();var r=document.getElementById('results');if(r)obs.observe(r,{childList:true,subtree:true});var p=document.getElementById('propertyType');if(p)p.addEventListener('change',function(){setTimeout(reconcile,0)})});window.addEventListener('load',reconcile);})();</script>`;

fs.readFileSync = function patchedReadFileSync(file, options) {
  const out = originalReadFileSync(file, options);
  if (typeof file === 'string' && /(?:^|[\\/])index\.html$/i.test(file) && typeof out === 'string') {
    return out.includes('</body>') ? out.replace('</body>', uiPatch + '</body>') : out + uiPatch;
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
require('./compat-server');
