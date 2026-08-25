const { URL } = require('url');
const PORTAL='Adresowo';
const MAX_PAGES=10;
const FETCH_TIMEOUT_MS=15000;
function num(v){if(v==null)return null;const s=String(v).replace(/\u00a0/g,' ').replace(/\s/g,'').replace(/,/g,'.').replace(/[^0-9.]/g,'');const n=Number(s);return Number.isFinite(n)?n:null;}
function abs(h,b){try{return new URL(h,b).href}catch{return '';}}
function areaFilter(a,target,tol){const t=Number(target);if(!Number.isFinite(t)||t<=0)return a;const p=Number(tol);const lo=t*(1-(Number.isFinite(p)?p:10)/100),hi=t*(1+(Number.isFinite(p)?p:10)/100);return a.filter(x=>x.area>=lo&&x.area<=hi);}
function clean(s){return String(s||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;/gi,"'").replace(/\s+/g,' ').trim();}
function lastMatch(text,re){const flags=re.flags.replace('g','')+'g';const rx=new RegExp(re.source,flags);let m,last=null;while((m=rx.exec(text)))last=m;return last;}
function extractResultsHtml(html){
  const sectionStart=html.search(/<section\b[^>]*aria-labelledby=["']offer-list-heading["'][^>]*>/i);
  if(sectionStart<0)return '';
  const sectionEnd=html.indexOf('</section>',sectionStart);
  if(sectionEnd<0)return '';
  const section=html.slice(sectionStart,sectionEnd);
  const listStart=section.search(/<div\b[^>]*id=["']offer-list-results["'][^>]*>/i);
  if(listStart<0)return '';
  return section.slice(listStart);
}
function parse(html,base){
  const scope=extractResultsHtml(html);
  if(!scope)return [];
  const offers=[],seen=new Set();
  const re=/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;let m;
  while((m=re.exec(scope))){
    const anchorText=clean(m[2]);
    if(!/Dom na (?:sprzedaż|wynajem)/i.test(anchorText))continue;
    const url=abs(m[1],base);if(!url||seen.has(url))continue;
    const cardStart=Math.max(0,m.index-3500),cardEnd=Math.min(scope.length,m.index+3500),card=clean(scope.slice(cardStart,cardEnd));
    const priceMatch=lastMatch(card,/([0-9][0-9\s\u00a0.]*)\s*zł/i),areaMatch=lastMatch(card,/([0-9]+(?:[,.][0-9]+)?)\s*m(?:²|2)/i);
    if(!priceMatch||!areaMatch)continue;
    const p=num(priceMatch[1]),a=num(areaMatch[1]);if(!p||!a)continue;
    const location=anchorText.replace(/\s+Dom na (?:sprzedaż|wynajem).*$/i,'').trim();if(!location)continue;
    const streetMatch=location.match(/(?:ul\.|al\.|aleja|pl\.)\s+(.+)$/i),street=streetMatch?streetMatch[1].trim():'';
    const locality=location.replace(/\s+(?:ul\.|os\.|al\.|aleja|plac|pl\.)\s+.*$/i,'').trim()||location;
    seen.add(url);offers.push({source:PORTAL,type:'Dom',location,locality,street,url,price:p,area:a,priceM2:p/a,title:anchorText});
  }
  return offers;
}
function findNextPage(html,base){
  const scope=extractResultsHtml(html);if(!scope)return '';
  const patterns=[/<a\b[^>]*rel=["'][^"']*next[^"']*["'][^>]*href=["']([^"']+)["']/i,/<a\b[^>]*href=["']([^"']+)["'][^>]*rel=["'][^"']*next[^"']*["']/i,/<a\b[^>]*href=["']([^"']+)["'][^>]*>\s*(?:następna|następne|next|›|»)\s*<\/a>/i];
  for(const re of patterns){const m=scope.match(re);if(m)return abs(m[1],base);}
  return '';
}
async function fetchHtml(url){const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),FETCH_TIMEOUT_MS);try{const r=await fetch(url,{redirect:'follow',signal:ac.signal,headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36','Accept':'text/html,application/xhtml+xml,*/*','Accept-Language':'pl-PL,pl;q=0.9'}});return{status:r.status,ok:r.ok,url:r.url,html:await r.text()};}finally{clearTimeout(tm);}}
function slugLocation(location='Olsztyn'){return String(location).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ł/g,'l').replace(/ą/g,'a').replace(/ę/g,'e').replace(/ó/g,'o').replace(/ś/g,'s').replace(/ź/g,'z').replace(/ż/g,'z').replace(/ć/g,'c').replace(/ń/g,'n').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');}
async function searchAdresowoHouses({location='Olsztyn',areaTarget=150,tolerance=10}={}){
  const start=new URL(`/domy/${slugLocation(location)}/`,'https://adresowo.pl').href;let url=start,pages=0,all=[];const seenPages=new Set(),diagnostics=[];
  while(url&&pages<MAX_PAGES&&!seenPages.has(url)){
    seenPages.add(url);const r=await fetchHtml(url);pages++;
    if(!r.ok){diagnostics.push({page:pages,url,status:r.status,htmlLength:r.html.length});break;}
    const scope=extractResultsHtml(r.html),got=parse(r.html,r.url);all.push(...got);
    const next=findNextPage(r.html,r.url);
    diagnostics.push({page:pages,url:r.url,status:r.status,htmlLength:r.html.length,scopeLength:scope.length,domHouseLinks:(scope.match(/Dom na (?:sprzedaż|wynajem)/gi)||[]).length,recognized:got.length,nextPage:next||null});
    if(!next||next===r.url||seenPages.has(next)||got.length===0)break;
    url=next;
  }
  const uniq=[...new Map(all.map(o=>[o.url,o])).values()],filtered=areaFilter(uniq,areaTarget,tolerance);
  return{portal:PORTAL,propertyType:'Dom',requestedLocation:location,url:start,httpStatus:pages?200:0,fetched:pages>0,recognized:uniq.length,complete:uniq.length,filtered:filtered.length,areaTarget:Number(areaTarget)||null,tolerance:Number(tolerance)||0,radiusSupported:false,pagesFetched:pages,diagnostics,offers:filtered};
}
module.exports={PORTAL,parse,searchAdresowoHouses,search:searchAdresowoHouses};