const https = require("https");
const { URL } = require("url");

const TARGET_URL = "https://gratka.pl/nieruchomosci/mieszkania/olsztyn";

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139 Safari/537.36", "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8" } }, res => {
      let html = ""; res.setEncoding("utf8"); res.on("data", c => html += c);
      res.on("end", () => resolve({ status: res.statusCode, html, finalUrl: res.headers.location || url }));
    });
    req.on("error", reject); req.setTimeout(30000, () => req.destroy(new Error("timeout")));
  });
}
function jsonLd(html) { const out=[]; for(const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { out.push(JSON.parse(m[1].trim())); } catch(_){} } return out; }
function flatten(x){const out=[];const walk=v=>{if(!v||typeof v!=="object")return;if(Array.isArray(v))return v.forEach(walk);out.push(v);Object.values(v).forEach(walk)};walk(x);return out;}
function num(v){if(v==null)return null;const n=Number(String(v).replace(/\s/g,"").replace(/zł/gi,"").replace(/[^0-9,.-]/g,"").replace(",","."));return Number.isFinite(n)?n:null;}
function ar(v){if(v==null)return null;const m=String(v).match(/([0-9]+(?:[.,][0-9]+)?)\s*m(?:²|2|kw)/i);return m?num(m[1]):num(v);}
function norm(v){try{const u=new URL(String(v),TARGET_URL);u.hash="";[...u.searchParams.keys()].forEach(k=>{if(/utm_|fbclid|gclid/i.test(k))u.searchParams.delete(k)});return u.href.replace(/\/$/,"").toLowerCase()}catch(_){return String(v||"").trim().toLowerCase();}}
function addr(item){const a=item?.address;if(typeof a==="string")return{locality:a,street:""};if(a&&typeof a==="object")return{locality:a.addressLocality||"",street:a.streetAddress||""};return{locality:"",street:""};}
function parseProduct(product, offer){
  const item=product||{};
  const offered=offer?.itemOffered&&typeof offer.itemOffered==="object"?offer.itemOffered:{};
  const p=num(offer?.price??offer?.priceSpecification?.price??item.offers?.price);
  const a=ar(offered.floorSize?.value??offered.floorSize??item.floorSize?.value??item.floorSize??item.area??item.description);
  const u=norm(offer?.url||item.url||"");
  const ad=addr(offered.address||item.address);
  if(p==null||a==null||!u)return null;
  return{source:"Gratka",type:"mieszkanie",locality:ad.locality,street:ad.street,price:p,area:a,priceM2:p/a,url:u};
}
function extract(roots){
  const rows=[];
  for(const root of roots) for(const obj of flatten(root)){
    const t=Array.isArray(obj["@type"])?obj["@type"]:[obj["@type"]];
    if(!t.includes("Product"))continue;
    const container=obj.offers;
    const offers=container?.offers
      ? (Array.isArray(container.offers)?container.offers:[container.offers])
      : (Array.isArray(container)?container:[container]);
    for(const offer of offers){const row=parseProduct(obj,offer);if(row)rows.push(row);}
  }
  return rows;
}
function dedupe(rows){const urls=new Set(),keys=new Set(),unique=[],duplicates=[];for(const r of rows){const u=r.url,k=`${r.price}|${r.area}`;if((u&&urls.has(u))||keys.has(k)){duplicates.push(r);continue;}if(u)urls.add(u);keys.add(k);unique.push(r);}return{unique,duplicates};}
async function searchGratka({areaTarget=62,tolerance=10}={}){const r=await fetchHtml(TARGET_URL),roots=jsonLd(r.html),recognized=extract(roots),complete=recognized.filter(o=>o.locality&&Number.isFinite(o.price)&&Number.isFinite(o.area)&&o.url),minArea=areaTarget*(1-tolerance/100),maxArea=areaTarget*(1+tolerance/100),filtered=complete.filter(o=>o.area>=minArea&&o.area<=maxArea),d=dedupe(filtered);return{portal:"Gratka",sourceUrl:TARGET_URL,httpStatus:r.status,fetched:r.status>=200&&r.status<400,htmlLength:r.html.length,recognized:recognized.length,complete:complete.length,filtered:filtered.length,unique:d.unique.length,duplicates:d.duplicates.length,offers:d.unique};}
module.exports={searchGratka};
