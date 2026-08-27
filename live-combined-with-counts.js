const base=require('./live-combined-api-v05');
const {getPortalTotals}=require('./portal-counts');
const {searchPlots}=require('./live-parser-plots');
const {searchMorizonPlots}=require('./live-morizon-plots');
const {searchDomiportaPlots}=require('./live-domiporta-plots');
const {searchGratkaPlots}=require('./parser-gratka-plots');
const {searchAdresowoPlots}=require('./live-adresowo-plots');
const {resolveLocation}=require('./location-resolver');

async function runPlotsWithoutOtodom(payload={}){
  const location=payload.location||'Olsztyn';
  const area=Number(payload.area||1000);
  const tolerance=Number(payload.tolerance??10);
  const radius=Math.max(0,Number(payload.radius)||0);
  const resolved=await resolveLocation(location);
  const canonicalLocation=resolved.name||resolved.input||location;
  const wojewodztwo=resolved.wojewodztwo||'warminsko-mazurskie';
  const [no,morizon,domiporta,gratka,adresowo]=await Promise.all([
    searchPlots({location:canonicalLocation,areaTarget:area,tolerance,radius}),
    searchMorizonPlots({location:canonicalLocation,areaTarget:area,tolerance,radius}),
    searchDomiportaPlots({location:canonicalLocation,wojewodztwo,areaTarget:area,tolerance,radius}),
    searchGratkaPlots({location:canonicalLocation,areaTarget:area,tolerance,radius}),
    searchAdresowoPlots({location:canonicalLocation,areaTarget:area,tolerance,radius})
  ]);
  const lives=[no,morizon,domiporta,gratka,adresowo];
  const sources=lives.map(live=>{
    const offers=live.offers||[];
    return{
      portal:live.portal,
      httpStatus:live.httpStatus,
      fetched:live.fetched,
      htmlLength:live.htmlLength,
      recognized:live.recognized,
      complete:live.complete??offers.length,
      filtered:live.filtered??offers.length,
      uniqueAfterCrossPortal:offers.length,
      requestedRadius:radius,
      appliedRadius:Number(live.appliedRadius||0),
      searchScope:canonicalLocation,
      radiusSupported:Boolean(live.radiusSupported),
      radiusStrategy:live.radiusStrategy,
      pagesFetched:live.pagesFetched,
      portalAreaRange:live.portalAreaRange,
      pages:live.pages,
      diagnostics:live.diagnostics,
      offers
    };
  });
  const before=sources.flatMap(s=>s.offers||[]);
  const cross=base.dedupeOffers(before);
  return{
    version:'0.5.2-plots-no-otodom',
    propertyType:'działka',
    inputLocation:location,
    resolvedLocation:resolved,
    location:canonicalLocation,
    area,
    tolerance,
    minArea:area*(1-tolerance/100),
    maxArea:area*(1+tolerance/100),
    radius,
    beforeCrossDedup:before.length,
    unique:cross.rows.length,
    duplicatesRemoved:cross.duplicates.length,
    duplicates:cross.duplicates,
    sources,
    offers:cross.rows
  };
}

async function run(payload={}){
  const dataType=String(payload.propertyType||'mieszkanie').toLowerCase();
  const isPlots=dataType.includes('dział')||dataType.includes('dzial');
  if(isPlots)return runPlotsWithoutOtodom(payload);
  const data=await base.run(payload);
  const type=String(payload.propertyType||data.propertyType||'mieszkanie').toLowerCase();
  if(type.includes('mieszkan')){
    const location=data.location||payload.location||'Olsztyn';
    const totals=await getPortalTotals(location);
    data.sources=(data.sources||[]).map(source=>({
      ...source,
      portalTotal:totals[source.portal]?.total??null,
      portalTotalStatus:totals[source.portal]?.status||0,
      portalTotalFetched:Boolean(totals[source.portal]?.fetched)
    }));
  }
  return data;
}

module.exports={...base,run,runPlotsWithoutOtodom};
