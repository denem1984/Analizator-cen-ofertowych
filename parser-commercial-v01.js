const { URL } = require('url');

const MAX_PAGES = 20;
const TIMEOUT = 25000;

const slug = v => String(v || '').trim().toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const abs = (v, base) => {
  try { const u = new URL(String(v), base); u.hash = ''; return u.href.replace(/\/$/, '').toLowerCase(); }
  catch { return ''; }
};

const strip = v => String(v || '')
  .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') v = v.value ?? v.amount ?? v.price ?? v.lowPrice ?? v.minValue ?? v.maxValue;
  const s = String(v).replace(/\u00a0/g, ' ').replace(/zł|PLN/gi, '').trim();
  const cleaned = s.replace(/\s/g, '').replace(/[^0-9,.-]/g, '');
  if (!cleaned) return null;
  let normalized = cleaned;
  if (normalized.includes(',') && normalized.includes('.')) normalized = normalized.replace(/\./g, '').replace(',', '.');
  else normalized = normalized.replace(',', '.');
  const n = Number(normalized); return Number.isFinite(n) ? n : null;
}

function areaFrom(v) {
  if (v == null) return null;
  if (typeof v === 'object') v = v.value ?? v.minValue ?? v.maxValue ?? v.amount;
  const s = String(v).replace(/\u00a0/g, ' ');
  const m = s.match(/([0-9]+(?:[.,][0-9]+)?)\s*m\s*(?:²|2|kw|kw\.)?\b/i);
  return m ? num(m[1]) : num(s);
}

function priceFrom(v) {
  if (v == null) return null;
  if (typeof v === 'object') v = v.value ?? v.price ?? v.lowPrice ?? v.amount;
  const s = String(v).replace(/\u00a0/g, ' ');
  const m = s.match(/([0-9][0-9\s.,]{2,})\s*(?:zł|PLN)\b/i);
  return m ? num(m[1]) : num(s);
}

function classify(text, fallback = 'Nieruchomość komercyjna') {
  const s = String(text || '').toLowerCase();
  if (/budynek\s+użytkowy|budynek\s+komercyjny/.test(s)) return 'Budynek użytkowy';
  if (/magazyn|hala/.test(s)) return 'Magazyn / hala';
  if (/lokal\s+użytkowy|lokal\s+handlowy|lokal\s+usługowy/.test(s)) return 'Lokal użytkowy';
  if (/biuro/.test(s)) return 'Biuro';
  return fallback;
}

// ZASADA DEDUPLIKACJI — NIE ZMIENIAĆ:
// ten sam URL LUB ta sama cena + ta sama powierzchnia.
function unique(rows) {
  const su = new Set(), sd = new Set(), out = [];
  for (const r of rows) {
    const u = String(r.url || '').toLowerCase();
    const d = `${r.price}|${r.area}`;
    if ((u && su.has(u)) || sd.has(d)) continue;
    if (u) su.add(u);
    sd.add(d);
    out.push(r);
  }
  return out;
}

async function get(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { redirect:'follow', signal:controller.signal, headers:{
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
      'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language':'pl-PL,pl;q=0.9,en;q=0.8'
    }});
    return { status:r.status, ok:r.ok, finalUrl:r.url, html:await r.text() };
  } finally { clearTimeout(timer); }
}

function jsonRoots(html) {
  const roots=[];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { roots.push(JSON.parse(m[1].trim())); } catch (_) {}
  }
  return roots;
}

function collect(root, predicate, limit=80) {
  const found=[], seen=new Set();
  const walk=v=>{
    if(found.length>=limit || v==null || typeof v!=='object' || seen.has(v)) return;
    seen.add(v); if(predicate(v)) found.push(v);
    if(Array.isArray(v)) for(const x of v) walk(x); else for(const x of Object.values(v)) walk(x);
  }; walk(root); return found;
}

function firstNested(root, keys) {
  const wanted=new Set(keys); let found; const seen=new Set();
  const walk=v=>{
    if(found!==undefined || v==null || typeof v!=='object' || seen.has(v)) return;
    seen.add(v);
    if(!Array.isArray(v)) for(const k of Object.keys(v)) if(wanted.has(k)&&v[k]!=null){found=v[k];return;}
    if(Array.isArray(v)) for(const x of v) walk(x); else for(const x of Object.values(v)) walk(x);
  }; walk(root); return found;
}

function makeRow(source, location, url, price, area, title='', street='') {
  if(!url || !Number.isFinite(price) || !Number.isFinite(area) || area<=0 || price<=0) return null;
  return {source,type:classify(title),locality:location,street:String(street||'').trim(),price,area,priceM2:price/area,url,title:String(title||'').trim()};
}

function extractJsonRows(html, base, source, location) {
  const rows=[];
  for(const root of jsonRoots(html)) {
    const candidates=collect(root,obj=>{
      const raw=JSON.stringify(obj);
      return /https?:\\?\/\\?(?:www\.)?(?:morizon|gratka|domiporta|adresowo|nieruchomosci-online)\.pl/i.test(raw)
        ||/(?:morizon|gratka|domiporta|adresowo|nieruchomosci-online)\.pl/i.test(raw);
    },300);
    for(const obj of candidates){
      const url=abs(firstNested(obj,['url','@id','mainEntityOfPage']),base); if(!url) continue;
      const price=priceFrom(firstNested(obj,['price','lowPrice','amount']));
      const area=areaFrom(firstNested(obj,['floorSize','area','surface','size','livingArea']));
      const title=firstNested(obj,['name','headline','description'])||'';
      const addr=firstNested(obj,['address']);
      const locality=typeof addr==='object'?(addr.addressLocality||addr.locality||location):location;
      const street=typeof addr==='object'?(addr.streetAddress||addr.street||''):'';
      const row=makeRow(source,locality||location,url,price,area,title,street); if(row) rows.push(row);
      if(rows.length>500) return rows;
    }
  }
  return rows;
}

function offerLinks(html, base, source) {
  const out=[],seen=new Set();
  for(const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
    const url=abs(m[1],base); if(!url||seen.has(url)) continue;
    const ok=source==='Morizon'?/morizon\.pl\/oferta\//i.test(url)
      :source==='Gratka'?/gratka\.pl\/nieruchomosci\//i.test(url)&&!/\/szukaj|\/wyszukiwarka/i.test(url)
      :source==='Domiporta'?/domiporta\.pl\/nieruchomosci\//i.test(url)
      :source==='Adresowo'?/adresowo\.pl\/o\//i.test(url)
      :/nieruchomosci-online\.pl\/.*(?:na-sprzedaz|na-wynajem)/i.test(url)||/nieruchomosci-online\.pl\/[^/]+,na-sprzedaz\//i.test(url);
    if(!ok) continue; seen.add(url); out.push({url,label:strip(m[2]),index:m.index});
  }
  return out;
}

function extractHtmlRows(html,base,source,location,minArea,maxArea){
  const rows=[];
  for(const link of offerLinks(html,base,source)){
    const text=strip(html.slice(Math.max(0,link.index-1800),Math.min(html.length,link.index+3500)));
    const prices=[...text.matchAll(/([0-9][0-9\s.,]{2,})\s*(?:zł|PLN)\b/gi)].map(m=>num(m[1])).filter(Number.isFinite);
    const areas=[...text.matchAll(/([0-9]+(?:[.,][0-9]+)?)\s*m\s*(?:²|2|kw)\b/gi)].map(m=>num(m[1])).filter(Number.isFinite);
    const area=areas.find(a=>a>=Math.max(10,minArea)&&a<=Math.min(2000,maxArea))??areas.find(a=>a>=10&&a<=2000);
    const price=prices.find(p=>p>=1000)??prices[0];
    if(!Number.isFinite(price)||!Number.isFinite(area)||area<minArea||area>maxArea) continue;
    const row=makeRow(source,location,link.url,price,area,link.label||text.slice(0,180)); if(row) rows.push(row);
  }
  return rows;
}

function pageUrl(base,page,mode){
  if(page===1) return base;
  const u=new URL(base);
  if(mode==='morizon'||mode==='gratka'||mode==='domiporta') u.searchParams.set(mode==='morizon'||mode==='gratka'?'page':'PageNumber',String(page));
  else if(mode==='no') u.searchParams.set('p',String(page));
  else if(mode==='adresowo') return `${base.replace(/\/?$/,'')}/_l${page}`;
  return u.href;
}

async function fetchPages(baseUrls,source,location,minArea,maxArea,mode){
  const all=[],pages=[]; const seenPages=new Set(); const seenOffers=new Set();
  for(const base of baseUrls){
    for(let page=1;page<=MAX_PAGES;page++){
      const url=pageUrl(base,page,mode); if(seenPages.has(url)) break; seenPages.add(url);
      let r; try{r=await get(url);}catch(e){pages.push({page,url,httpStatus:0,htmlLength:0,newOffers:0,error:String(e.message||e)});break;}
      const final=r.finalUrl||url;
      if(r.status<200||r.status>=400){pages.push({page,url:final,httpStatus:r.status,htmlLength:r.html.length,newOffers:0});break;}
      let rows=extractJsonRows(r.html,final,source,location);
      const recognized=rows.length;
      if(!rows.length) rows=extractHtmlRows(r.html,final,source,location,minArea,maxArea);
      rows=rows.filter(o=>o.area>=minArea&&o.area<=maxArea);
      let newOffers=0;
      for(const row of rows){const key=(row.url||`${row.price}|${row.area}`).toLowerCase();if(!seenOffers.has(key)){seenOffers.add(key);all.push(row);newOffers++;}}
      pages.push({page,url:final,httpStatus:r.status,htmlLength:r.html.length,recognized,newOffers});
      if(newOffers===0) break;
    }
  }
  return {rows:all,pages};
}

async function morizon(location,minArea,maxArea){
  const u=new URL(`https://www.morizon.pl/komercyjne/${slug(location)}/`);
  u.searchParams.set('ps[living_area_from]',String(Math.ceil(minArea))); u.searchParams.set('ps[living_area_to]',String(Math.floor(maxArea)));
  const result=await fetchPages([u.href],'Morizon',location,minArea,maxArea,'morizon'); const offers=unique(result.rows);
  return {portal:'Morizon',httpStatus:result.pages[0]?.httpStatus||0,fetched:result.pages.some(p=>p.httpStatus>=200&&p.httpStatus<400),htmlLength:result.pages.reduce((n,p)=>n+p.htmlLength,0),recognized:result.rows.length,complete:offers.length,offers,pagesFetched:result.pages.length,pages:result.pages,requestedRadius:0,appliedRadius:0,radiusSupported:false};
}

async function gratka(location,minArea,maxArea){
  const u=new URL(`https://gratka.pl/nieruchomosci/lokale-uzytkowe/${slug(location)}/wtorny`);
  u.searchParams.set('powierzchnia-w-m2:min',String(Math.ceil(minArea))); u.searchParams.set('powierzchnia-w-m2:max',String(Math.floor(maxArea)));
  const result=await fetchPages([u.href],'Gratka',location,minArea,maxArea,'gratka'); const offers=unique(result.rows);
  return {portal:'Gratka',httpStatus:result.pages[0]?.httpStatus||0,fetched:result.pages.some(p=>p.httpStatus>=200&&p.httpStatus<400),htmlLength:result.pages.reduce((n,p)=>n+p.htmlLength,0),recognized:result.rows.length,complete:offers.length,offers,pagesFetched:result.pages.length,pages:result.pages,requestedRadius:0,appliedRadius:0,radiusSupported:false};
}

async function domiporta(location,minArea,maxArea){
  const urls=[`https://www.domiporta.pl/lokal-uzytkowy/sprzedam/warminsko-mazurskie/${slug(location)}?Surface.From=${Math.ceil(minArea)}&Surface.To=${Math.floor(maxArea)}`,`https://www.domiporta.pl/magazyn/sprzedam/warminsko-mazurskie/${slug(location)}?Surface.From=${Math.ceil(minArea)}&Surface.To=${Math.floor(maxArea)}`];
  const result=await fetchPages(urls,'Domiporta',location,minArea,maxArea,'domiporta'); const offers=unique(result.rows);
  return {portal:'Domiporta',httpStatus:result.pages.find(p=>p.httpStatus)?.httpStatus||0,fetched:result.pages.some(p=>p.httpStatus>=200&&p.httpStatus<400),htmlLength:result.pages.reduce((n,p)=>n+p.htmlLength,0),recognized:result.rows.length,complete:offers.length,offers,pagesFetched:result.pages.length,pages:result.pages,requestedRadius:0,appliedRadius:0,radiusSupported:false};
}

function parseNO(html,base,location,minArea,maxArea,category){
  const rows=[];
  for(const link of offerLinks(html,base,'Nieruchomości-online')){
    const text=strip(html.slice(Math.max(0,link.index-1500),Math.min(html.length,link.index+3000)));
    const price=(text.match(/([0-9][0-9\s.,]{2,})\s*(?:zł|PLN)\b/i)||[])[1];
    const am=text.match(/([0-9]+(?:[.,][0-9]+)?)\s*m\s*(?:²|2)\b/i); const p=num(price),a=am?num(am[1]):null;
    if(!Number.isFinite(p)||!Number.isFinite(a)||a<minArea||a>maxArea) continue;
    const title=category==='budynek-uzytkowy'?'Budynek użytkowy':'Lokal użytkowy';
    rows.push({source:'Nieruchomości-online',type:title,locality:location,street:'',price:p,area:a,priceM2:p/a,url:link.url,title});
  }
  return rows;
}

async function nieruchomosciOnline(location,minArea,maxArea){
  if(location.toLowerCase()!=='olsztyn') return {portal:'Nieruchomości-online',httpStatus:0,fetched:false,htmlLength:0,recognized:0,complete:0,offers:[],error:'Brak identyfikatora lokalizacji dla tej miejscowości.'};
  const categories=['lokal-uzytkowy','budynek-uzytkowy']; const rows=[],pages=[];
  for(const category of categories){
    const u=`https://www.nieruchomosci-online.pl/szukaj.html?3,${category},sprzedaz,,Olsztyn:18670,,,,,${Math.floor(minArea)}-${Math.ceil(maxArea)}&q=`;
    const result=await fetchPages([u],'Nieruchomości-online',location,minArea,maxArea,'no');
    for(const p of result.pages) pages.push({...p,category}); rows.push(...result.rows);
  }
  const offers=unique(rows);
  return {portal:'Nieruchomości-online',httpStatus:pages[0]?.httpStatus||0,fetched:pages.some(p=>p.httpStatus>=200&&p.httpStatus<400),htmlLength:pages.reduce((n,p)=>n+p.htmlLength,0),recognized:rows.length,complete:offers.length,offers,pagesFetched:pages.length,pages,categories,requestedRadius:0,appliedRadius:0,radiusSupported:false};
}

async function adresowo(location,minArea,maxArea){
  const u=`https://adresowo.pl/f/nieruchomosci-komercyjne/${slug(location)}/a${Math.floor(minArea)}-${Math.ceil(maxArea)}`;
  const result=await fetchPages([u],'Adresowo',location,minArea,maxArea,'adresowo'); const offers=unique(result.rows);
  return {portal:'Adresowo',httpStatus:result.pages[0]?.httpStatus||0,fetched:result.pages.some(p=>p.httpStatus>=200&&p.httpStatus<400),htmlLength:result.pages.reduce((n,p)=>n+p.htmlLength,0),recognized:result.rows.length,complete:offers.length,offers,pagesFetched:result.pages.length,pages:result.pages,requestedRadius:0,appliedRadius:0,radiusSupported:false};
}

async function searchCommercial({location='Olsztyn',area=62,tolerance=10,radius=0}={}){
  const a=Number(area),t=Number(tolerance),minArea=a*(1-t/100),maxArea=a*(1+t/100);
  const [m,g,d,no,ad]=await Promise.all([morizon(location,minArea,maxArea),gratka(location,minArea,maxArea),domiporta(location,minArea,maxArea),nieruchomosciOnline(location,minArea,maxArea),adresowo(location,minArea,maxArea)]);
  return [m,g,d,no,ad].map(x=>({...x,requestedRadius:Number(radius)||0,appliedRadius:0,radiusSupported:false}));
}

module.exports={searchCommercial};
