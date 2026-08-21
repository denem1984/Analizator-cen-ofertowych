const http = require("http");
const { URL } = require("url");
const { searchNieruchomosciOnline } = require("./live-parser");
const { searchDomiporta } = require("./parser-domiporta-v05");

const PORT = process.env.PORT || 10000;

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function normalizeUrl(value) {
  try { const u = new URL(value); u.hash=""; u.search=""; return u.href.replace(/\/$/,"").toLowerCase(); }
  catch { return String(value||"").trim().toLowerCase(); }
}

function dedupe(offers) {
  const urls=new Set(), data=new Set(), unique=[], duplicates=[];
  for(const offer of offers){
    const u=normalizeUrl(offer.url), d=`${Number(offer.price)}|${Number(offer.area)}`;
    let reason=null;
    if(u && urls.has(u)) reason="ten sam znormalizowany URL";
    else if(d && d!=="NaN|NaN" && data.has(d)) reason="ta sama cena + ta sama powierzchnia";
    if(reason){ duplicates.push({reason, duplicate:offer}); continue; }
    if(u) urls.add(u); if(d && d!=="NaN|NaN") data.add(d); unique.push(offer);
  }
  return {unique,duplicates};
}

async function run(){
  const location="Olsztyn", target=62, tolerance=10, minArea=55.8, maxArea=68.2;
  const no=await searchNieruchomosciOnline({location});
  const dom=await searchDomiporta({areaTarget:target,tolerance});
  const noFiltered=no.offers.filter(o=>o.locality&&Number.isFinite(o.price)&&Number.isFinite(o.area)&&o.url&&o.area>=minArea&&o.area<=maxArea);
  const domFiltered=dom.offers.filter(o=>o.locality&&Number.isFinite(o.price)&&Number.isFinite(o.area)&&o.url&&o.area>=minArea&&o.area<=maxArea);
  const combined=[...noFiltered,...domFiltered];
  const d=dedupe(combined);
  return {version:"0.5.0-3portale-test",location,targetArea:target,tolerance,minArea,maxArea,sources:{nieruchomosciOnline:{httpStatus:no.httpStatus,recognized:no.recognized,complete:no.complete,filtered:noFiltered.length},domiporta:{httpStatus:dom.httpStatus,recognized:dom.recognized,complete:dom.complete,filtered:domFiltered.length}},beforeDedupe:combined.length,unique:d.unique.length,duplicates:d.duplicates.length,offers:d.unique,duplicateExamples:d.duplicates.slice(0,30)};
}

http.createServer(async(req,res)=>{
  const u=new URL(req.url,`http://${req.headers.host||"localhost"}`);
  if(u.pathname==="/health") return send(res,200,{ok:true});
  if(u.pathname==="/api/live/3portale") { try{return send(res,200,await run());}catch(e){return send(res,500,{error:e.message});} }
  return send(res,404,{error:"Nie znaleziono endpointu."});
}).listen(PORT,"0.0.0.0",()=>{
  console.log(`3-portale live v0.5 listening on ${PORT}`);
  run().then(r=>console.log("THREE_PORTAL_SELFTEST",JSON.stringify({beforeDedupe:r.beforeDedupe,unique:r.unique,duplicates:r.duplicates,sources:r.sources}))).catch(e=>console.error("THREE_PORTAL_SELFTEST_ERROR",e.message));
});
