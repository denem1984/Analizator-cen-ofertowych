const http = require("http");
const { URL } = require("url");

const TARGET_URL = "https://adresowo.pl/mieszkania/olsztyn/";
const PORT = Number(process.env.PORT) || 10000;

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { redirect:"follow", signal:controller.signal, headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36","Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","Accept-Language":"pl-PL,pl;q=0.9,en;q=0.8"} });
    return { status:response.status, ok:response.ok, finalUrl:response.url, html:await response.text() };
  } finally { clearTimeout(timer); }
}

function number(value){
  if(value==null)return null;
  const n=Number(String(value).replace(/\s/g,"").replace(/zł|PLN/gi,"").replace(/[^0-9,.-]/g,"").replace(",","."));
  return Number.isFinite(n)?n:null;
}
function area(value){
  if(value==null)return null;
  const m=String(value).match(/([0-9]+(?:[.,][0-9]+)?)\s*m(?:²|2|kw|kw\.)?/i);
  return m?number(m[1]):number(value);
}
function absUrl(value){
  try{const u=new URL(String(value),TARGET_URL);u.hash="";return u.href.replace(/\/$/,"").toLowerCase();}catch{return "";}
}
function cleanHtml(s){
  return String(s||"").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&#39;/gi,"'").replace(/&quot;/gi,'"').replace(/\s+/g," ").trim();
}
function jsonLd(html){
  const out=[]; const re=/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi; let m;
  while((m=re.exec(html))){try{out.push(JSON.parse(m[1].trim()));}catch{}}
  return out;
}
function flatten(v,out=[]){if(!v||typeof v!=="object")return out;if(Array.isArray(v)){v.forEach(x=>flatten(x,out));return out;}out.push(v);Object.values(v).forEach(x=>flatten(x,out));return out;}
function findValue(obj,keys){for(const x of flatten(obj))for(const k of keys)if(x[k]!=null)return x[k];return null;}
function address(v){if(!v)return {locality:"",street:""};if(typeof v==="string")return {locality:v,street:""};return {locality:v.addressLocality||v.locality||v.city||"",street:v.streetAddress||v.street||v.addressLine||""};}

function extractJsonLd(roots){
  const rows=[];
  for(const obj of roots.flatMap(x=>flatten(x))){
    const types=Array.isArray(obj["@type"])?obj["@type"]:[obj["@type"]];
    if(!(types.includes("Offer")||types.includes("Product")||types.includes("RealEstateListing")||obj.itemOffered))continue;
    const variants=obj.offers?(Array.isArray(obj.offers)?obj.offers:[obj.offers]):[obj];
    for(const offer of variants){
      const item=offer.itemOffered&&typeof offer.itemOffered==="object"?offer.itemOffered:obj.itemOffered||obj;
      const p=number(offer.price??offer.priceSpecification?.price??offer.lowPrice??findValue(offer,["price","lowPrice"]));
      const a=area(findValue(item,["floorSize","area","size"]));
      const u=absUrl(offer.url||item.url||obj.url);
      const ad=address(item.address||obj.address);
      if(p!=null&&a!=null&&u)rows.push({source:"Adresowo",type:"mieszkanie",locality:String(ad.locality||"").trim(),street:String(ad.street||"").trim(),price:p,area:a,priceM2:p/a,url:u});
    }
  }
  return rows;
}

// Adresowo's category page currently exposes offers as /o/... links in HTML.
// Extract the card containing each /o/ link, then read price and area from the card text.
function extractOfferCards(html){
  const rows=[];
  const linkRe=/<a\b[^>]*href=["']([^"']*\/o\/[^"']+)["'][^>]*>[\s\S]*?<\/a>/gi;
  let m;
  while((m=linkRe.exec(html))){
    const href=absUrl(m[1]);
    if(!href)continue;
    const start=Math.max(0,m.index-1800);
    const end=Math.min(html.length,linkRe.lastIndex+5000);
    const block=html.slice(start,end);
    const text=cleanHtml(block);
    const priceMatches=[...text.matchAll(/([0-9][0-9\s.]*)\s*(?:zł|PLN)\b/gi)];
    const areaMatches=[...text.matchAll(/([0-9]+(?:[.,][0-9]+)?)\s*m(?:²|2)\b/gi)];
    if(!priceMatches.length||!areaMatches.length)continue;
    const p=number(priceMatches[0][1]);
    const a=number(areaMatches[0][1]);
    if(!p||!a||a<10||a>500)continue;
    const titleMatch=text.match(/Mieszkanie[^.]{0,180}(?:Olsztyn|olsztyn)[^.]{0,180}/i);
    const locality=/Olsztyn/i.test(text)?"Olsztyn":"";
    rows.push({source:"Adresowo",type:"mieszkanie",locality,street:"",price:p,area:a,priceM2:p/a,url:href,title:titleMatch?titleMatch[0]:""});
  }
  return rows;
}

function dedupe(rows){
  const urls=new Set(),keys=new Set(),unique=[],duplicates=[];
  for(const r of rows){
    const u=r.url,k=`${r.price}|${r.area}`;
    if((u&&urls.has(u))||keys.has(k)){duplicates.push(r);continue;}
    if(u)urls.add(u);keys.add(k);unique.push(r);
  }
  return {unique,duplicates};
}

async function searchAdresowo({areaTarget=62,tolerance=10}={}){
  const response=await fetchHtml(TARGET_URL);
  const roots=jsonLd(response.html);
  const jsonRows=extractJsonLd(roots);
  const cardRows=extractOfferCards(response.html);
  const combined=[...jsonRows,...cardRows];
  const seen=new Set();
  const parsed=combined.filter(o=>{const k=`${o.url}|${o.price}|${o.area}`;if(seen.has(k))return false;seen.add(k);return true;});
  const complete=parsed.filter(o=>o.locality&&Number.isFinite(o.price)&&Number.isFinite(o.area)&&o.url);
  const minArea=areaTarget*(1-tolerance/100),maxArea=areaTarget*(1+tolerance/100);
  const filtered=complete.filter(o=>o.area>=minArea&&o.area<=maxArea);
  const d=dedupe(filtered);
  return {portal:"Adresowo",sourceUrl:TARGET_URL,httpStatus:response.status,fetched:response.ok,htmlLength:response.html.length,recognized:parsed.length,complete:complete.length,filtered:filtered.length,unique:d.unique.length,duplicates:d.duplicates.length,offers:d.unique};
}

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url||"/",`http://${req.headers.host||"localhost"}`);
    if(u.pathname==="/health"){res.writeHead(200,{"Content-Type":"application/json; charset=utf-8"});return res.end(JSON.stringify({ok:true,portal:"Adresowo"}));}
    if(u.pathname==="/api/adresowo"){
      const areaTarget=Number(u.searchParams.get("area")||62),tolerance=Number(u.searchParams.get("tolerance")||10);
      const result=await searchAdresowo({areaTarget,tolerance});res.writeHead(200,{"Content-Type":"application/json; charset=utf-8"});return res.end(JSON.stringify(result));
    }
    res.writeHead(200,{"Content-Type":"application/json; charset=utf-8"});res.end(JSON.stringify({service:"Adresowo parser v0.5",status:"ok",endpoints:["/health","/api/adresowo?area=62&tolerance=10"]}));
  }catch(e){res.writeHead(500,{"Content-Type":"application/json; charset=utf-8"});res.end(JSON.stringify({ok:false,error:String(e?.message||e)}));}
});
server.listen(PORT,"0.0.0.0",()=>{
  console.log(`ADRESOWO_SERVER_LISTENING port=${PORT}`);
  searchAdresowo({areaTarget:62,tolerance:10}).then(r=>console.log("ADRESOWO_SELFTEST "+JSON.stringify({httpStatus:r.httpStatus,fetched:r.fetched,htmlLength:r.htmlLength,recognized:r.recognized,complete:r.complete,filtered:r.filtered,unique:r.unique,duplicates:r.duplicates}))).catch(e=>console.error("ADRESOWO_SELFTEST_ERROR "+e.message));
});
