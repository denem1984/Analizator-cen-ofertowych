const { URL } = require("url");
const PORTAL="Morizon";
const MAX_PAGES=50;
const FETCH_TIMEOUT_MS=15000;
function asNumber(v){if(v===null||v===undefined||v==='')return null;if(typeof v==='number')return Number.isFinite(v)?v:null;const s=String(v).replace(/\s/g,'').replace(',','.').replace(/[^0-9.\-]/g,'');const n=Number(s);return Number.isFinite(n)?n:null;}
function absUrl(href,base){if(!href)return '';try{return new URL(href,base).href}catch{return '';}}
function walk(x,out){if(Array.isArray(x))return x.forEach(v=>walk(v,out));if(!x||typeof x!=='object')return;const t=x['@type'];if(t==='Offer'||(Array.isArray(t)&&t.includes('Offer')))out.push(x);Object.values(x).forEach(v=>walk(v,out));}
function parseJsonLd(html){const offers=[];const re=/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;let m;while((m=re.exec(html))){try{walk(JSON.parse(m[1].trim()),offers)}catch(_){}}return offers;}
function makeOffer(o,base){const item=o.itemOffered||o.item||o.mainEntity||{},addr=item.address||o.address||{},fs=item.floorSize||o.floorSize||{},price=asNumber(o.price??item.price),area=asNumber(fs.value??item.area??item.floorSize),url=absUrl(o.url||item.url,base),locality=String(addr.addressLocality||item.addressLocality||'').trim(),street=String(addr.streetAddress||item.streetAddress||'').trim();if(!price||!area||!url)return null;return{source:PORTAL,type:'Lokal mieszkalny',locality,street,location:locality?(street?`${locality}, ${street}`:locality):'',url,price,area,priceM2:area>0?price/area:null,title:String(o.name||item.name||'').trim()};}
function parseMorizon(html,base){const raw=parseJsonLd(html),offers=[],seen=new Set();for(const o of raw){const item=makeOffer(o,base);if(!item||!item.locality)continue;const key=`${item.url}|${item.price}|${item.area}`;if(seen.has(key))continue;seen.add(key);offers.push(item);}return{recognized:raw.length,offers};}
async function fetchHtml(url){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),FETCH_TIMEOUT_MS);try{const response=await fetch(url,{redirect:'follow',signal:controller.signal,headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36','Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':'pl-PL,pl;q=0.9,en;q=0.8'}});return{status:response.status,ok:response.ok,finalUrl:response.url,html:await response.text()};}finally{clearTimeout(timer);}}
function slugLocation(location='Olsztyn'){return String(location).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ł/g,'l').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');}
function pageNumber(url){const n=Number(new URL(url).searchParams.get('page')||1);return Number.isFinite(n)&&n>0?Math.floor(n):1;}
function nextPageFromHtml(html,baseUrl,currentPage){
  const links=[...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)];
  for(const m of links){const u=absUrl(m[1],baseUrl);if(!u)continue;const p=pageNumber(u);if(p===currentPage+1)return u;}
  const relNext=html.match(/<a\b[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i)||html.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*rel=["']next["']/i);
  if(relNext){const u=absUrl(relNext[1],baseUrl);if(u&&pageNumber(u)===currentPage+1)return u;}
  return null;
}
async function searchMorizon({location='Olsztyn',path}={}){
  const slug=slugLocation(location),startUrl=new URL(path||`/mieszkania/${slug}/`,'https://www.morizon.pl').href;
  let currentUrl=startUrl,pagesFetched=0,totalHtmlLength=0,totalRecognized=0;
  const pageUrls=[],allOffers=[],seenPageUrls=new Set(),seenOfferUrls=new Set();
  while(currentUrl&&pagesFetched<MAX_PAGES){
    const normalized=absUrl(currentUrl,currentUrl);if(!normalized||seenPageUrls.has(normalized))break;
    seenPageUrls.add(normalized);
    const result=await fetchHtml(currentUrl);pagesFetched++;pageUrls.push(result.finalUrl||currentUrl);totalHtmlLength+=result.html.length;
    if(!result.ok)break;
    const parsed=parseMorizon(result.html,result.finalUrl||currentUrl);totalRecognized+=parsed.recognized;
    for(const offer of parsed.offers){const key=offer.url.toLowerCase();if(!seenOfferUrls.has(key)){seenOfferUrls.add(key);allOffers.push(offer);}}
    if(parsed.offers.length===0)break;
    const next=nextPageFromHtml(result.html,result.finalUrl||currentUrl,pageNumber(result.finalUrl||currentUrl));
    if(next){currentUrl=next;continue;}
    const nextPage=pageNumber(result.finalUrl||currentUrl)+1;
    currentUrl=new URL(result.finalUrl||currentUrl);
    currentUrl.searchParams.set('page',String(nextPage));
    currentUrl=currentUrl.href;
  }
  return{portal:PORTAL,requestedLocation:location,url:startUrl,httpStatus:200,fetched:pagesFetched>0,htmlLength:totalHtmlLength,recognized:totalRecognized,complete:allOffers.filter(o=>o.locality&&o.price!=null&&o.area!=null&&o.url).length,offers:allOffers,pagesFetched,pageUrls};
}
module.exports={PORTAL,parseMorizon,searchMorizon};