const https=require('https');const http=require('http');const{URL}=require('url');
const MAX_PAGES=50;
const FETCH_TIMEOUT_MS=30000;
function slugLocation(location='Olsztyn'){return String(location).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ł/g,'l').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');}
function targetUrl(location='Olsztyn'){return `https://gratka.pl/nieruchomosci/mieszkania/${slugLocation(location)}`;}
function fetchHtml(url){return new Promise((resolve,reject)=>{const req=https.get(url,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139 Safari/537.36','Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':'pl-PL,pl;q=0.9,en;q=0.8'}},res=>{let html='';res.setEncoding('utf8');res.on('data',c=>html+=c);res.on('end',()=>resolve({status:res.statusCode,html,finalUrl:res.headers.location||url}));});req.on('error',reject);req.setTimeout(FETCH_TIMEOUT_MS,()=>req.destroy(new Error('timeout')));});}
function jsonLd(html){const out=[];for(const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{out.push(JSON.parse(m[1].trim()));}catch(_){}}return out;}
function flatten(x){const out=[];const walk=v=>{if(!v||typeof v!=='object')return;if(Array.isArray(v))return v.forEach(walk);out.push(v);Object.values(v).forEach(walk)};walk(x);return out;}
function findFirst(root,keys){const wanted=new Set(keys);let found=null;const walk=v=>{if(found!==null||v==null||typeof v!=='object')return;if(Array.isArray(v)){for(const x of v)walk(x);return;}for(const k of Object.keys(v)){if(wanted.has(k)&&v[k]!=null){found=v[k];return;}}for(const x of Object.values(v))walk(x);};walk(root);return found;}
function num(v){if(v==null)return null;if(typeof v==='object')v=v.value??v.lowPrice??v.price;const n=Number(String(v).replace(/\s/g,'').replace(/zł/gi,'').replace(/[^0-9,.-]/g,'').replace(',','.'));return Number.isFinite(n)?n:null;}
function ar(v){if(v==null)return null;if(typeof v==='object')v=v.value??v.minValue??v.maxValue;const m=String(v).match(/([0-9]+(?:[.,][0-9]+)?)\s*m(?:²|2|kw)?/i);return m?num(m[1]):num(v);}
function norm(v,base){try{const u=new URL(String(v),base);u.hash='';[...u.searchParams.keys()].forEach(k=>{if(/utm_|fbclid|gclid/i.test(k))u.searchParams.delete(k)});return u.href.replace(/\/$/,'').toLowerCase();}catch(_){return String(v||'').trim().toLowerCase();}}
function addr(v){const a=v&&typeof v==='object'?v:{};return{locality:a.addressLocality||a.locality||a.city||'',street:a.streetAddress||a.street||a.addressLine||''};}
function offerVariants(product){const c=product?.offers;if(!c)return[];if(Array.isArray(c))return c.flatMap(x=>x?.offers?(Array.isArray(x.offers)?x.offers:[x.offers]):[x]);if(c.offers)return Array.isArray(c.offers)?c.offers:[c.offers];return[c];}
function parseProduct(product,offer,base){const offered=offer?.itemOffered&&typeof offer.itemOffered==='object'?offer.itemOffered:{};const p=num(offer?.price??offer?.priceSpecification?.price??offer?.lowPrice??findFirst(offer,['price','lowPrice'])??findFirst(product,['price','lowPrice','highPrice']));const area=ar(findFirst(offered,['floorSize','area','size'])??findFirst(product,['floorSize','area','size']));const u=norm(offer?.url||findFirst(offered,['url'])||product.url||findFirst(product,['url']),base);const a=addr(offered.address||findFirst(offered,['address'])||product.address||findFirst(product,['address']));if(p==null||area==null||!u)return null;return{source:'Gratka',type:'mieszkanie',locality:a.locality,street:a.street,price:p,area,priceM2:p/area,url:u};}
function extract(roots,base){const rows=[];for(const root of roots)for(const obj of flatten(root)){const t=Array.isArray(obj['@type'])?obj['@type']:[obj['@type']];if(!t.includes('Product'))continue;for(const offer of offerVariants(obj)){const row=parseProduct(obj,offer,base);if(row)rows.push(row);}}return rows;}
function dedupe(rows){const urls=new Set(),keys=new Set(),unique=[],duplicates=[];for(const r of rows){const u=r.url,k=`${r.price}|${r.area}`;if((u&&urls.has(u))||keys.has(k)){duplicates.push(r);continue;}if(u)urls.add(u);keys.add(k);unique.push(r);}return{unique,duplicates};}
function pageNumber(url){try{const n=Number(new URL(url).searchParams.get('page')||1);return Number.isFinite(n)&&n>0?Math.floor(n):1;}catch(_){return 1;}}
function absUrl(href,base){if(!href)return null;try{return new URL(href,base).href;}catch(_){return null;}}
function nextPageFromHtml(html,baseUrl,currentPage){
  const links=[...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)];
  const candidates=[];
  for(const m of links){const u=absUrl(m[1],baseUrl);if(!u)continue;const p=pageNumber(u);if(p===currentPage+1)candidates.push(u);}
  if(candidates.length)return candidates[0];
  const relNext=[...html.matchAll(/<a\b[^>]*\brel\s*=\s*["']next["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi),...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*\brel\s*=\s*["']next["'][^>]*>/gi)];
  for(const m of relNext){const u=absUrl(m[1],baseUrl);if(u&&pageNumber(u)===currentPage+1)return u;}
  return null;
}
async function searchGratka({location='Olsztyn',areaTarget=62,tolerance=10,radius=0}={}){
  const sourceUrl=targetUrl(location);
  let currentUrl=sourceUrl,pagesFetched=0,totalHtmlLength=0,totalRecognized=0,firstStatus=0,lastStatus=0;
  const allRows=[],seenPageUrls=new Set();
  while(currentUrl&&pagesFetched<MAX_PAGES){
    const normalized=norm(currentUrl,currentUrl);if(!normalized||seenPageUrls.has(normalized))break;
    seenPageUrls.add(normalized);
    const r=await fetchHtml(currentUrl);pagesFetched++;firstStatus=firstStatus||Number(r.status)||0;lastStatus=Number(r.status)||0;totalHtmlLength+=r.html.length;
    if(!(r.status>=200&&r.status<400))break;
    const pageBase=r.finalUrl||currentUrl,roots=jsonLd(r.html),recognized=extract(roots,pageBase);
    totalRecognized+=recognized.length;
    allRows.push(...recognized);
    if(recognized.length===0)break;
    const currentPage=pageNumber(pageBase),next=nextPageFromHtml(r.html,pageBase,currentPage);
    if(!next)break;
    currentUrl=next;
  }
  const complete=allRows.filter(o=>o.locality&&Number.isFinite(o.price)&&Number.isFinite(o.area)&&o.url),minArea=areaTarget*(1-tolerance/100),maxArea=areaTarget*(1+tolerance/100),filtered=complete.filter(o=>o.area>=minArea&&o.area<=maxArea),d=dedupe(filtered);
  return{portal:'Gratka',requestedLocation:location,sourceUrl,httpStatus:firstStatus||lastStatus,fetched:firstStatus>=200&&firstStatus<400,htmlLength:totalHtmlLength,recognized:totalRecognized,complete:complete.length,filtered:filtered.length,unique:d.unique.length,duplicates:d.duplicates.length,offers:d.unique,requestedRadius:Number(radius)||0,appliedRadius:0,radiusSupported:false,pagesFetched};
}
module.exports={searchGratka};
if(require.main===module||process.argv[1]===undefined){const port=Number(process.env.PORT)||10000;http.createServer(async(req,res)=>{try{const u=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);if(u.pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify({ok:true,portal:'Gratka'}));}if(u.pathname==='/api/gratka'){const result=await searchGratka({location:u.searchParams.get('location')||'Olsztyn',areaTarget:Number(u.searchParams.get('area')||62),tolerance:Number(u.searchParams.get('tolerance')||10),radius:Number(u.searchParams.get('radius')||0)});res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify(result));}res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({service:'Gratka parser v0.5',status:'ok'}));}catch(e){res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({ok:false,error:String(e?.message||e)}));}}).listen(port,'0.0.0.0',()=>console.log(`GRATKA_SERVER_LISTENING port=${port}`);setInterval(()=>{},2147483647);}
