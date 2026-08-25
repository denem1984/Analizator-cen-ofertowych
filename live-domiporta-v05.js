const http = require('http');
const https = require('https');
const { URL } = require('url');
const TARGET_URL = 'https://www.domiporta.pl/dzialke/sprzedam/warminsko-mazurskie/olsztyn';
const PORT = process.env.PORT || 10000;
let lastResult = { status: 'not_tested', message: 'Test Domiporta jeszcze się nie wykonał.' };

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Zbyt wiele przekierowań Domiporta'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8'
      }
    }, res => {
      const location = res.headers.location;
      if (location && [301,302,303,307,308].includes(res.statusCode)) {
        const next = new URL(location, url).href;
        res.resume();
        return fetchText(next, redirects + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, html: data, finalUrl: url, contentType: res.headers['content-type'] || '', server: res.headers.server || '', locationHeader: location || null, redirects }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  });
}

function diagnostics(html) {
  return {
    jsonLdScripts: [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>/gi)].length,
    listItemOccurrences: (html.match(/ListItem/gi) || []).length,
    offerOccurrences: (html.match(/\bOffer\b/gi) || []).length,
    productOccurrences: (html.match(/Product/gi) || []).length,
    looksBlocked: /captcha|challenge|access denied|cloudflare|just a moment|robot|blocked/i.test(html),
    startsWith: html.slice(0, 300).replace(/\s+/g, ' ')
  };
}
function parseJsonLd(html) {
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)], out=[];
  for (const m of scripts) { try { const v=JSON.parse(m[1].trim()); const walk=x=>{ if(!x||typeof x!=='object')return; if(Array.isArray(x))return x.forEach(walk); if(x.itemListElement)walk(x.itemListElement); if(x.item)walk(x.item); if(x.offers){for(const offer of (Array.isArray(x.offers)?x.offers:[x.offers])) if(offer&&typeof offer==='object') out.push({parent:x,offer});} if(x['@type']==='Offer')out.push({parent:x,offer:x}); }; walk(v); } catch (_) {} }
  return out;
}
function number(v){if(v==null)return null;const s=String(v).replace(/\s/g,'').replace(/zł/gi,'').replace(/[^0-9,.-]/g,'').replace(',','.');const n=Number(s);return Number.isFinite(n)?n:null;}
function areaFromText(s){if(s==null)return null;const m=String(s).match(/([0-9]+(?:[.,][0-9]+)?)\s*m(?:²|2|kw)/i);return m?number(m[1]):number(s);}
function normalizeUrl(url){try{const u=new URL(url,TARGET_URL);u.hash='';[...u.searchParams.keys()].forEach(k=>{if(/utm_|fbclid|gclid/i.test(k))u.searchParams.delete(k)});return u.toString().replace(/\/$/,'').toLowerCase();}catch(_){return String(url||'').trim().toLowerCase();}}
function extractLocation(parent,offer){const item=parent||{},a=item.itemOffered||item.item||item,address=a.address||item.address||offer.address;if(typeof address==='string')return address;if(address&&typeof address==='object')return[address.addressLocality,address.streetAddress].filter(Boolean).join(', ');return item.name||a.name||'';}
function parse(html){const found=parseJsonLd(html),rows=[],seen=new Set();for(const {parent,offer} of found){const price=number(offer.price||offer.priceSpecification?.price),item=parent.itemOffered||parent.item||parent,area=areaFromText(item.floorSize||item.area||item.description||''),url=normalizeUrl(offer.url||item.url||parent.url||'');if(price==null||area==null||!url)continue;const key=`${url}|${price}|${area}`;if(seen.has(key))continue;seen.add(key);rows.push({source:'Domiporta',type:'Działka',location:extractLocation(parent,offer),url,price,area,priceM2:area?price/area:null});}return rows;}
function dedup(rows){const seenUrl=new Set(),seenPA=new Set(),unique=[],duplicates=[];for(const row of rows){const u=row.url,pa=`${row.price}|${row.area}`;if(seenUrl.has(u)||seenPA.has(pa)){duplicates.push({reason:seenUrl.has(u)?'ten sam znormalizowany URL':'ta sama cena + ta sama powierzchnia',duplicate:row});continue;}seenUrl.add(u);seenPA.add(pa);unique.push(row);}return{unique,duplicates};}
async function run(){const target=1000,tol=10,min=target*(1-tol/100),max=target*(1+tol/100),r=await fetchText(TARGET_URL),diag=diagnostics(r.html),parsed=parse(r.html),complete=parsed.filter(x=>x.price!=null&&x.area!=null&&x.url),filtered=complete.filter(x=>x.area>=min&&x.area<=max),d=dedup(filtered);return{portal:'Domiporta',propertyType:'Działka',testedAt:new Date().toISOString(),targetArea:target,tolerance:tol,minArea:min,maxArea:max,httpStatus:r.status,fetched:r.status>=200&&r.status<400,finalUrl:r.finalUrl,contentType:r.contentType,server:r.server,locationHeader:r.locationHeader,redirects:r.redirects||0,htmlLength:r.html.length,diagnostics:diag,recognized:parsed.length,complete:complete.length,filtered:filtered.length,unique:d.unique.length,duplicates:d.duplicates,offers:d.unique};}
async function executeTest(reason='startup'){console.log(`DOMIPORTA_PLOTS_TEST_START reason=${reason}`);try{lastResult=await run();console.log(`DOMIPORTA_PLOTS_TEST_RESULT http=${lastResult.httpStatus} redirects=${lastResult.redirects} bytes=${lastResult.htmlLength} jsonld=${lastResult.diagnostics.jsonLdScripts} offers=${lastResult.diagnostics.offerOccurrences} blocked=${lastResult.diagnostics.looksBlocked} recognized=${lastResult.recognized} complete=${lastResult.complete} filtered=${lastResult.filtered} unique=${lastResult.unique} duplicates=${lastResult.duplicates.length}`);}catch(e){lastResult={status:'error',testedAt:new Date().toISOString(),error:e.message};console.error(`DOMIPORTA_PLOTS_TEST_ERROR ${e.stack||e.message}`);}}
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json; charset=utf-8');try{if(req.url==='/health')return res.end(JSON.stringify({ok:true}));if(req.url==='/api/live/domiporta')return res.end(JSON.stringify(lastResult));if(req.url==='/api/live/domiporta/diagnostics')return res.end(JSON.stringify(lastResult));if(req.url==='/api/live/domiporta/run')return executeTest('manual').then(()=>res.end(JSON.stringify(lastResult)));return res.end(JSON.stringify(lastResult));}catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}));}});
server.listen(PORT,()=>{console.log(`Domiporta plots live v0.6 listening on ${PORT}`);executeTest('startup');});