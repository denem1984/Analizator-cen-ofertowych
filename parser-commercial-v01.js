const { URL } = require('url');

// Wyszukiwanie komercyjne musi być ograniczone czasowo. Wcześniej parser wykonywał
// do 30 stron portalu sekwencyjnie, a Adresowo dodatkowo pobierało kolejno strony
// każdej oferty. Przy połączeniu 5 portali kończyło się to 502 z bramy.
const MAX_PAGES = 12;
const ADRESOWO_MAX_LISTING_URLS = 40;
const FETCH_TIMEOUT_MS = 10000;
const ADRESOWO_CONCURRENCY = 8;

function slug(v='') {
  return String(v).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ł/g,'l').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
}
function num(v) {
  if (v == null) return null;
  if (typeof v === 'object') v = v.value ?? v.amount ?? v.minValue ?? v.maxValue ?? v.price;
  const n = Number(String(v).replace(/\s/g,'').replace(/zł|PLN/gi,'').replace(/[^0-9,.-]/g,'').replace(',','.'));
  return Number.isFinite(n) ? n : null;
}
function area(v) {
  if (v == null) return null;
  if (typeof v === 'object') v = v.value ?? v.minValue ?? v.maxValue ?? v.amount;
  const s = String(v);
  const m = s.match(/([0-9]+(?:[.,][0-9]+)?)\s*m(?:²|2|kw)?/i);
  return num(m ? m[1] : s);
}
function abs(v, base) {
  try { const u=new URL(String(v),base); u.hash=''; return u.href.replace(/\/$/,'').toLowerCase(); }
  catch { return ''; }
}
function fetchHtml(url, timeoutMs=FETCH_TIMEOUT_MS) {
  return new Promise((resolve,reject)=>{
    const c=new AbortController();
    const t=setTimeout(()=>c.abort(),timeoutMs);
    fetch(url,{redirect:'follow',signal:c.signal,headers:{
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
      'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language':'pl-PL,pl;q=0.9,en;q=0.8'
    }})
      .then(async r=>resolve({status:r.status,ok:r.ok,finalUrl:r.url,html:await r.text()}))
      .catch(reject)
      .finally(()=>clearTimeout(t));
  });
}
function jsonRoots(html) {
  const out=[]; const re=/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for(const m of html.matchAll(re)){try{out.push(JSON.parse(m[1].trim()))}catch{}}
  return out;
}
function walk(root,cb) {
  if(!root||typeof root!=='object')return;
  cb(root);
  if(Array.isArray(root)) for(const x of root)walk(x,cb);
  else for(const x of Object.values(root))walk(x,cb);
}
function addressOf(x, fallback) {
  const a=x?.address;
  if(typeof a==='string')return{locality:a,street:''};
  if(a&&typeof a==='object')return{locality:a.addressLocality||a.locality||fallback,street:a.streetAddress||a.street||''};
  return{locality:fallback,street:''};
}
function parseStructured(html,base,portal,fallback) {
  const rows=[];
  for(const root of jsonRoots(html)) walk(root,obj=>{
    const types=Array.isArray(obj['@type'])?obj['@type']:[obj['@type']];
    if(types.includes('Offer')){
      const item=obj.itemOffered||obj.item||obj.mainEntity||{};
      const price=num(obj.price ?? obj.priceSpecification?.price ?? item.price);
      const ar=area(obj.floorSize ?? obj.area ?? item.floorSize ?? item.area);
      const url=abs(obj.url||item.url||obj['@id']||item['@id'],base);
      const a=addressOf(item,fallback);
      if(price!=null&&ar!=null&&url) rows.push({source:portal,type:'Nieruchomość komercyjna',locality:a.locality||fallback,street:a.street||'',price,area:ar,priceM2:price/ar,url,title:String(obj.name||item.name||'').trim()});
    } else if(types.includes('Product')){
      const offered=obj.itemOffered||{}; const offers=obj.offers; const list=Array.isArray(offers)?offers:(offers?[offers]:[]);
      for(const offer of list){
        const price=num(offer?.price ?? offer?.priceSpecification?.price ?? offer?.lowPrice ?? obj.price);
        const ar=area(offered.floorSize ?? offered.area ?? obj.floorSize ?? obj.area);
        const url=abs(offer?.url||obj.url||offered.url||obj['@id'],base);
        const a=addressOf(offered.address?offered:obj,fallback);
        if(price!=null&&ar!=null&&url) rows.push({source:portal,type:'Nieruchomość komercyjna',locality:a.locality||fallback,street:a.street||'',price,area:ar,priceM2:price/ar,url,title:String(obj.name||offered.name||'').trim()});
      }
    }
  });
  return rows;
}
function parseHtmlFallback(html,base,portal,fallback) {
  const rows=[];
  const links=[...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  for(const m of links){
    const href=abs(m[1],base); if(!href)continue;
    if(!/(morizon|gratka|domiporta|nieruchomosci-online)\.pl/i.test(href))continue;
    const text=String(m[2]).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    const start=Math.max(0,m.index-1800),end=Math.min(html.length,m.index+m[0].length+1800),chunk=html.slice(start,end).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
    const ps=[...chunk.matchAll(/([0-9][0-9\s.]{2,})\s*(?:zł|PLN)\b/gi)].map(x=>num(x[1])).filter(Number.isFinite);
    const as=[...chunk.matchAll(/([0-9]+(?:[.,][0-9]+)?)\s*m(?:²|2)\b/gi)].map(x=>num(x[1])).filter(x=>x>=5&&x<=10000);
    if(ps.length&&as.length) rows.push({source:portal,type:'Nieruchomość komercyjna',locality:fallback,street:'',price:ps[0],area:as[0],priceM2:ps[0]/as[0],url:href,title:text});
  }
  return rows;
}
function unique(rows) {
  const su=new Set(),sd=new Set(),out=[];
  for(const r of rows){
    const u=r.url,d=`${r.price}|${r.area}`;
    if((u&&su.has(u))||sd.has(d))continue;
    if(u)su.add(u);sd.add(d);out.push(r);
  }
  return out;
}
function pageUrl(base,page,param){const u=new URL(base);if(page>1)u.searchParams.set(param,String(page));else u.searchParams.delete(param);return u.href;}
async function fetchPages(base,param,portal,fallback){
  const rows=[]; let pagesFetched=0,totalHtml=0,recognized=0,firstStatus=0;
  const seenPages=new Set(),seenOffers=new Set(),pages=[];
  for(let page=1;page<=MAX_PAGES;page++){
    const url=pageUrl(base,page,param); if(seenPages.has(url))break; seenPages.add(url);
    let r;
    try{r=await fetchHtml(url)}catch(e){pages.push({page,url,httpStatus:0,error:String(e.message||e)});break;}
    pagesFetched++; if(!firstStatus)firstStatus=r.status; totalHtml+=r.html.length;
    pages.push({page,url:r.finalUrl||url,httpStatus:r.status,htmlLength:r.html.length});
    if(!r.ok)break;
    let parsed=parseStructured(r.html,r.finalUrl||url,portal,fallback);
    if(!parsed.length)parsed=parseHtmlFallback(r.html,r.finalUrl||url,portal,fallback);
    recognized+=parsed.length;
    let fresh=0;
    for(const x of parsed){if(!seenOffers.has(x.url)){seenOffers.add(x.url);rows.push(x);fresh++;}}
    pages[pages.length-1].newOffers=fresh;
    if(!fresh)break;
  }
  return{rows,pagesFetched,totalHtml,recognized,firstStatus,pages};
}
async function searchAdresowoCommercial(location){
  const base=`https://adresowo.pl/nieruchomosci-komercyjne/${slug(location)}/`;
  let pageUrl=base,pagesFetched=0,listingUrls=[],seenPages=new Set();
  while(pageUrl&&pagesFetched<MAX_PAGES&&listingUrls.length<ADRESOWO_MAX_LISTING_URLS){
    if(seenPages.has(pageUrl))break; seenPages.add(pageUrl);
    let r; try{r=await fetchHtml(pageUrl)}catch{break}
    pagesFetched++; if(!r.ok)break;
    for(const m of r.html.matchAll(/href=["']([^"']+)["']/gi)){
      if(!/^\/o\//i.test(m[1]))continue;
      const u=abs(m[1],r.finalUrl||pageUrl);
      if(u&&!listingUrls.includes(u))listingUrls.push(u);
      if(listingUrls.length>=ADRESOWO_MAX_LISTING_URLS)break;
    }
    const next=r.html.match(/href=["']([^"']+)["'][^>]*>\s*(?:Następna|Next)/i);
    if(next)pageUrl=abs(next[1],r.finalUrl||pageUrl);
    else {
      const u=new URL(r.finalUrl||pageUrl); const mm=u.pathname.match(/\/_l(\d+)/); const p=mm?Number(mm[1]):1;
      if(p>=MAX_PAGES)break;
      u.pathname=u.pathname.replace(/\/_l\d+/,'')+`_l${p+1}`; pageUrl=u.href;
    }
  }
  const rows=[];
  for(let i=0;i<listingUrls.length;i+=ADRESOWO_CONCURRENCY){
    const batch=listingUrls.slice(i,i+ADRESOWO_CONCURRENCY);
    const parsed=await Promise.all(batch.map(async u=>{
      try{
        const r=await fetchHtml(u);
        if(!r.ok)return null;
        const text=r.html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/\s+/g,' ');
        const title=(r.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||'';
        const am=text.match(/([0-9]+(?:[.,][0-9]+)?)\s*m(?:²|2)\b/); const pm=text.match(/([0-9][0-9 .\u00a0]*)\s*zł\b/i);
        const ar=area(am?.[1]),pr=num(pm?.[1]);
        if(ar==null||pr==null)return null;
        return{source:'Adresowo',type:'Nieruchomość komercyjna',locality:location,street:'',price:pr,area:ar,priceM2:pr/ar,url:u,title:title.replace(/<[^>]+>/g,' ').trim()};
      }catch{return null;}
    }));
    for(const x of parsed)if(x)rows.push(x);
  }
  const u=unique(rows);
  return{portal:'Adresowo',rows:u,pagesFetched,recognized:rows.length,complete:u.length,sourceUrl:base,httpStatus:200,fetched:pagesFetched>0,htmlLength:0,radiusSupported:true,appliedRadius:0};
}
async function searchCommercial({location='Olsztyn',radius=0}={}){
  const s=slug(location),woj='warminsko-mazurskie';
  const configs=[
    {portal:'Morizon',base:`https://www.morizon.pl/komercyjne/${s}/`,param:'page'},
    {portal:'Gratka',base:`https://gratka.pl/nieruchomosci/lokale-uzytkowe/inne-obiekty/${s}`,param:'page'},
    {portal:'Domiporta',base:`https://www.domiporta.pl/lokal-uzytkowy/sprzedam/${woj}/${s}`,param:'PageNumber'},
    {portal:'Nieruchomości-online',base:`https://${s}.nieruchomosci-online.pl/lokale-uzytkowe%2Csprzedaz/`,param:'p'}
  ];
  const portalJobs=configs.map(async c=>{
    const jobs=[fetchPages(c.base,c.param,c.portal,location)];
    if(c.portal==='Domiporta')jobs.push(fetchPages(`https://www.domiporta.pl/magazyn/sprzedam/${woj}/${s}`,'PageNumber',c.portal,location));
    const parts=await Promise.all(jobs); const x=parts[0];
    for(const m of parts.slice(1)){x.rows.push(...m.rows);x.pagesFetched+=m.pagesFetched;x.totalHtml+=m.totalHtml;x.recognized+=m.recognized;x.pages=x.pages.concat(m.pages);}
    const u=unique(x.rows);
    return{portal:c.portal,sourceUrl:c.base,httpStatus:x.firstStatus,fetched:x.firstStatus>=200&&x.firstStatus<400,htmlLength:x.totalHtml,recognized:x.recognized,complete:u.length,offers:u,pagesFetched:x.pagesFetched,pages:x.pages,requestedRadius:Number(radius)||0,appliedRadius:0,radiusSupported:c.portal==='Domiporta'||c.portal==='Nieruchomości-online'};
  });
  const [portalResults,adresowo]=await Promise.all([Promise.all(portalJobs),searchAdresowoCommercial(location)]);
  return[...portalResults,adresowo];
}
module.exports={searchCommercial};
