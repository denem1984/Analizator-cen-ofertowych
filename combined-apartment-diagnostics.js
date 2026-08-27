const {URL}=require('url');
const {searchNieruchomosciOnline}=require('./live-parser');
const {searchMorizon}=require('./live-morizon');
const {searchDomiporta}=require('./parser-domiporta-v05');
const {searchGratka}=require('./parser-gratka-v05');
const {search:searchAdresowo}=require('./parser-adresowo-v05');
const {searchOtodom}=require('./live-otodom');
const {resolveLocation}=require('./location-resolver');

function normalizeUrl(value){try{const u=new URL(value);u.hash='';u.search='';return u.href.replace(/\/$/,'').toLowerCase()}catch{return String(value||'').trim().toLowerCase()}}
function dedupeOffers(offers){const seenUrl=new Set(),seenData=new Set(),duplicates=[],result=[];for(const offer of offers){const urlKey=normalizeUrl(offer.url),price=Number(offer.price),area=Number(offer.area),dataKey=Number.isFinite(price)&&Number.isFinite(area)?`${price}|${area}`:'';let reason='';if(urlKey&&seenUrl.has(urlKey))reason='ten sam URL';else if(dataKey&&seenData.has(dataKey))reason='ta sama cena + ta sama powierzchnia';if(reason){const kept=result.find(x=>(urlKey&&normalizeUrl(x.url)===urlKey)||(dataKey&&`${Number(x.price)}|${Number(x.area)}`===dataKey));duplicates.push({reason,kept:kept||result[0],duplicate:offer});continue}if(urlKey)seenUrl.add(urlKey);if(dataKey)seenData.add(dataKey);result.push(offer)}return{rows:result,duplicates}}
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
 const sources=lives.map(live=>{const offers=live.offers||[],diagnostics=classify(offers,canonicalLocation,minArea,maxArea,live.portal);const complete=offers.filter(o=>(!o.locality||o.locality===canonicalLocation||live.portal==='Otodom')&&Number.isFinite(Number(o.price))&&Number.isFinite(Number(o.area))&&o.url);const filtered=complete.filter(o=>Number(o.area)>=minArea&&Number(o.area)<=maxArea);return{portal:live.portal,httpStatus:live.httpStatus,fetched:live.fetched,htmlLength:live.htmlLength,recognized:live.recognized,complete:complete.length,filtered:filtered.length,uniqueAfterCrossPortal:filtered.length,requestedRadius,appliedRadius:Number(live.appliedRadius||0),searchScope:Number(live.appliedRadius||0)>0?`+${Number(live.appliedRadius)} km`:canonicalLocation,radiusSupported:Boolean(live.radiusSupported),radiusStrategy:live.radiusStrategy,diagnostics,transport:live.transport,error:live.error,remoteError:live.remoteError,pagesFetched:live.pagesFetched,portalAreaRange:live.portalAreaRange,offers:filtered}});
 const before=sources.flatMap(s=>s.offers||[]),cross=dedupeOffers(before);
 return{version:'0.7.1-apartment-diagnostics',propertyType:'mieszkanie',inputLocation:location,resolvedLocation:resolved,location:canonicalLocation,wojewodztwo:resolved.wojewodztwo||'',area:target,tolerance:tol,minArea,maxArea,radius:requestedRadius,beforeCrossDedup:before.length,unique:cross.rows.length,duplicatesRemoved:cross.duplicates.length,duplicates:cross.duplicates,sources,offers:cross.rows,diagnostics:{totalRecognized:sources.reduce((a,s)=>a+Number(s.recognized||0),0),totalComplete:sources.reduce((a,s)=>a+Number(s.complete||0),0),totalFiltered:before.length,totalFinal:cross.rows.length,rejectionByPortal:Object.fromEntries(sources.map(s=>[s.portal,s.diagnostics]))}};
}
module.exports={runApartmentDiagnostic};
