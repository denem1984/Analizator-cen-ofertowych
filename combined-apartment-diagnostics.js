const {URL}=require('url');
const {searchNieruchomosciOnline}=require('./live-parser');
const {searchMorizon}=require('./live-morizon');
const {searchDomiporta}=require('./parser-domiporta-v05');
const {searchGratka}=require('./parser-gratka-v05');
const {search:searchAdresowo}=require('./parser-adresowo-v05');
const {searchOtodom}=require('./live-otodom');
const {resolveLocation}=require('./location-resolver');
function normalizeUrl(value){try{const u=new URL(value);u.hash='';u.search='';return u.href.replace(/\/$/,'').toLowerCase()}catch{return String(value||'').trim().toLowerCase()}}
function offerKey(o){const price=Number(o.price),area=Number(o.area);if(!Number.isFinite(price)||!Number.isFinite(area))return'';return `price|${price}|area|${area}`}
function dedupeOffers(offers){const seenUrl=new Map(),seenKey=new Map(),duplicates=[],result=[];for(const offer of offers){const urlKey=normalizeUrl(offer.url),dataKey=offerKey(offer);let reason='',kept=null;if(urlKey&&seenUrl.has(urlKey)){reason='ten sam URL';kept=seenUrl.get(urlKey)}else if(dataKey&&seenKey.has(dataKey)){reason='ta sama cena + ta sama powierzchnia';kept=seenKey.get(dataKey)}if(reason){duplicates.push({reason,kept,duplicate:offer});continue}if(urlKey)seenUrl.set(urlKey,offer);if(dataKey)seenKey.set(dataKey,offer);result.push(offer)}return{rows:result,duplicates}}
function classify(offers,canonicalLocation,minArea,maxArea,portal){let invalid=0,locationMismatch=0,areaOut=0,valid=0;for(const o of offers){const basic=Number.isFinite(Number(o.price))&&Number.isFinite(Number(o.area))&&o.url;if(!basic){invalid++;continue}if(o.locality&&o.locality!==canonicalLocation&&portal!=='Otodom'){locationMismatch++;continue}if(Number(o.area)<minArea||Number(o.area)>maxArea){areaOut++;continue}valid++}return{raw:offers.length,valid,invalid,locationMismatch,areaOut}}
async function runApartmentDiagnostic({location='Olsztyn',area=62,tolerance=10,radius=0}={}){
 const resolved=await resolveLocation(location),canonicalLocation=resolved.name||resolved.input||location;
 const target=Number(area)||62,tol=Number(tolerance)||0,minArea=target*(1-tol/100),maxArea=target*(1+tol/100),requestedRadius=Math.max(0,Number(radius)||0);
 const lives=await Promise.all([
  searchNieruchomosciOnline({location:canonicalLocation,radius:requestedRadius,areaTarget:target,tolerance:tol}),
  searchMorizon({location:canonicalLocation}),
  searchDomiporta({location:canonicalLocation,wojewodztwo:resolved.wojewodztwo||'',areaTarget:target,tolerance:tol,radius:requestedRadius}),
  searchGratka({location:canonicalLocation,areaTarget:target,tolerance:tol,radius:requestedRadius}),
  searchAdresowo({location:canonicalLocation,areaTarget:target,tolerance:tol,radius:requestedRadius}),
  searchOtodom({location:canonicalLocation,areaTarget:target,tolerance:tol,radius:requestedRadius,propertyType:'mieszkanie'})
 ]);
 const sources=lives.map(live=>{const rawOffers=live.offers||[],offers=rawOffers.map(o=>live.portal==='Otodom'?{...o,locality:o.locality||canonicalLocation,location:o.location||canonicalLocation}:o),diagnostics=classify(offers,canonicalLocation,minArea,maxArea,live.portal),complete=offers.filter(o=>(!o.locality||o.locality===canonicalLocation)&&Number.isFinite(Number(o.price))&&Number.isFinite(Number(o.area))&&o.url),filtered=complete.filter(o=>Number(o.area)>=minArea&&Number(o.area)<=maxArea);return{portal:live.portal,httpStatus:live.httpStatus,fetched:live.fetched,htmlLength:live.htmlLength,recognized:live.recognized,complete:complete.length,filtered:filtered.length,uniqueAfterCrossPortal:filtered.length,requestedRadius,appliedRadius:Number(live.appliedRadius||0),searchScope:Number(live.appliedRadius||0)>0?`+${Number(live.appliedRadius)} km`:canonicalLocation,radiusSupported:Boolean(live.radiusSupported),radiusStrategy:live.radiusStrategy,diagnostics,transport:live.transport,error:live.error,remoteError:live.remoteError,pagesFetched:live.pagesFetched,portalAreaRange:live.portalAreaRange,offers:filtered}});
 const before=sources.flatMap(s=>s.offers||[]),cross=dedupeOffers(before),keptByPortal=new Map();for(const o of cross.rows){const p=o.portal||o.source||'Źródło';keptByPortal.set(p,(keptByPortal.get(p)||0)+1)}for(const s of sources)s.uniqueAfterCrossPortal=keptByPortal.get(s.portal)||0;
 return{version:'0.7.4-apartment-diagnostics',propertyType:'mieszkanie',inputLocation:location,resolvedLocation:resolved,location:canonicalLocation,wojewodztwo:resolved.wojewodztwo||'',area:target,tolerance:tol,minArea,maxArea,radius:requestedRadius,beforeCrossDedup:before.length,unique:cross.rows.length,duplicatesRemoved:cross.duplicates.length,duplicates:cross.duplicates,sources,offers:cross.rows,diagnostics:{totalRecognized:sources.reduce((a,s)=>a+Number(s.recognized||0),0),totalComplete:sources.reduce((a,s)=>a+Number(s.complete||0),0),totalFiltered:before.length,totalFinal:cross.rows.length,rejectionByPortal:Object.fromEntries(sources.map(s=>[s.portal,s.diagnostics]))}};
}
module.exports={runApartmentDiagnostic};
