const https=require('https');
const {URL}=require('url');
const TIMEOUT=20000;

function slug(v=''){return String(v).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ł/g,'l').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');}
function fetchHtml(url){return new Promise((resolve,reject)=>{const req=https.get(url,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36','Accept':'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8','Accept-Language':'pl-PL,pl;q=0.9,en;q=0.8'}},res=>{let body='';res.setEncoding('utf8');res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode||0,body,url:res.headers.location||url}));});req.on('error',reject);req.setTimeout(TIMEOUT,()=>req.destroy(new Error('timeout')));});}
function clean(html){return String(html||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'\"').replace(/&#39;|&apos;/gi,"'").replace(/\s+/g,' ').trim();}
function parseNumber(s){const n=Number(String(s).replace(/\u00a0/g,' ').replace(/[ .]/g,'').replace(',','.'));return Number.isFinite(n)?n:null;}
function extractTotal(html){
  const raw=String(html||'');
  const keyPatterns=[
    /(?:totalCount|totalResults|numberOfResults|resultsCount|totalOffers|totalListings|listingCount)["']?\s*[:=]\s*["']?(\d{1,6})/i,
    /["'](?:totalCount|totalResults|numberOfResults|resultsCount|totalOffers|totalListings|listingCount)["']?\s*[:=]\s*\{[^}]{0,120}?["']?(?:value|count)["']?\s*[:=]\s*["']?(\d{1,6})/i
  ];
  for(const re of keyPatterns){const m=raw.match(re);if(m){const n=Number(m[1]);if(n>0&&n<1000000)return n;}}
  const text=clean(raw);
  const matches=[...text.matchAll(/\b(\d{1,6}(?:[ .]\d{3})?)\s+(?:ogłoszeń|ogłoszenia|ogłoszenie|ofert|oferta)\b/gi)];
  for(const m of matches){const n=parseNumber(m[1]);if(n!=null&&n>0&&n<1000000)return n;}
  return null;
}
function urlFor(portal,location){const s=slug(location);switch(portal){case'Nieruchomości-online':return `https://${s}.nieruchomosci-online.pl/szukaj.html?3,mieszkanie,sprzedaz,,${encodeURIComponent(location)}`;case'Morizon':return `https://www.morizon.pl/mieszkania/${s}/`;case'Domiporta':return `https://www.domiporta.pl/mieszkanie/sprzedam/warminsko-mazurskie/${s}`;case'Gratka':return `https://gratka.pl/nieruchomosci/mieszkania/${s}`;case'Adresowo':return `https://adresowo.pl/mieszkania/${s}/`;case'Otodom':return `https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/warminsko--mazurskie/${s}/${s}/${s}`;default:return'';}}
async function countPortal(portal,location){try{const url=urlFor(portal,location),r=await fetchHtml(url);return{portal,total:extractTotal(r.body),url,status:r.status,fetched:r.status>=200&&r.status<400};}catch(e){return{portal,total:null,url:urlFor(portal,location),status:0,fetched:false,error:String(e?.message||e)};}}
async function getPortalTotals(location){
  const portals=['Nieruchomości-online','Morizon','Domiporta','Gratka','Adresowo','Otodom'];
  const rows=await Promise.all(portals.map(p=>countPortal(p,location)));
  return Object.fromEntries(rows.map(x=>[x.portal,x]));
}
module.exports={getPortalTotals,countPortal,extractTotal};
