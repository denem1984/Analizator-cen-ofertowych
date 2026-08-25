const { URL } = require('url');
const PORTAL='Adresowo';
const MAX_PAGES=50;
const FETCH_TIMEOUT_MS=15000;
function num(v){if(v==null)return null;const s=String(v).replace(/\s/g,'').replace(/,/g,'.').replace(/[^0-9.]/g,'');const n=Number(s);return Number.isFinite(n)?n:null;}
function abs(h,b){try{return new URL(h,b).href}catch{return '';}}
function clean(s){return String(s||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();}
function areaFilter(a,target,tol){const t=Number(target);if(!Number.isFinite(t)||t<=0)return a;const p=Number(tol);const lo=t*(1-(Number.isFinite(p)?p:10)/100),hi=t*(1+(Number.isFinite(p)?p:10)/100);return a.filter(x=>x.area>=lo&&x.area<=hi);}
function parse(html,base){const offers=[],seen=new Set();
  // Adresowo nie opiera kart ofert na stabilnej klasie listing/offer. Stabilnym punktem są linki do /nieruchomosci/.
  const links=[...html.matchAll(/<a\b[^>]*href=["']((?:https?:\/\/adresowo\.pl)?\/nieruchomosci\/[^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  for(let i=0;i<links.length;i++){
    const m=links[i], href=m[1], pos=m.index||0;
    const nextPos=i+1<links.length?(links[i+1].index||html.length):html.length;
    const windowStart=Math.max(0,pos-2200), chunk=html.slice(windowStart,nextPos);
    const url=abs(href,base); if(!url||seen.has(url))continue;
    const text=clean(chunk);
    // Cena i metraż występują bezpośrednio przed tytułem/linkiem oferty.
    const priceMatches=[...text.matchAll(/([0-9]{1,3}(?:[\s.][0-9]{3})*|[0-9]+)\s*zł/gi)];
    const areaMatches=[...text.matchAll(/([0-9]+(?:[,.][0-9]+)?)\s*m(?:²|2)/gi)];
    if(!priceMatches.length||!areaMatches.length)continue;
    const p=num(priceMatches[priceMatches.length-1][1]), a=num(areaMatches[areaMatches.length-1][1]);
    if(!p||!a)continue;
    const title=clean(m[2]);
    const heading=(chunk.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)||[])[1];
    const fullTitle=clean(heading||title);
    const street=(fullTitle.match(/\bul\.\s*([^,]+?)(?=\s+Dom\s+na\s+sprzedaż|\s*$)/i)||[])[1]?.trim()||'';
    seen.add(url);
    offers.push({source:PORTAL,type:'Dom',location:'',locality:'',street, url,price:p,area:a,priceM2:p/a,title:fullTitle||title});
  }
  return offers;
}
async function fetchHtml(url){const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),FETCH_TIMEOUT_MS);try{const r=await fetch(url,{redirect:'follow',signal:ac.signal,headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36','Accept':'text/html,application/xhtml+xml,*/*','Accept-Language':'pl-PL,pl;q=0.9'}});return{status:r.status,ok:r.ok,url:r.url,html:await r.text()};}finally{clearTimeout(tm);}}
async function searchAdresowoHouses({location='Olsztyn',areaTarget=150,tolerance=10}={}){const start=new URL(`/domy/${String(location).trim().toLowerCase().replace(/ł/g,'l').replace(/ą/g,'a').replace(/ę/g,'e').replace(/ó/g,'o').replace(/ś/g,'s').replace(/ź/g,'z').replace(/ż/g,'z').replace(/ć/g,'c').replace(/ń/g,'n').replace(/[^a-z0-9]+/g,'-')}/`,'https://adresowo.pl').href;let url=start,pages=0,all=[],recognized=0;const seenPages=new Set();while(url&&pages<MAX_PAGES&&!seenPages.has(url)){seenPages.add(url);const r=await fetchHtml(url);pages++;if(!r.ok)break;const got=parse(r.html,r.url);recognized+=got.length;all.push(...got);const next=r.html.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>\s*(?:Następna|›|»)/i)||r.html.match(/<a\b[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i);if(next)url=abs(next[1],r.url);else break;}const uniq=[...new Map(all.map(o=>[o.url,o])).values()];for(const o of uniq){o.locality=String(location||'').trim();o.location=o.street?`${o.locality}, ${o.street}`:o.locality;}const filtered=areaFilter(uniq,areaTarget,tolerance);return{portal:PORTAL,propertyType:'Dom',requestedLocation:location,url:start,httpStatus:200,fetched:pages>0,recognized,complete:uniq.length,filtered:filtered.length,areaTarget:Number(areaTarget)||null,tolerance:Number(tolerance)||0,offers:filtered,pagesFetched:pages};}
module.exports={PORTAL,parse,searchAdresowoHouses,search:searchAdresowoHouses};