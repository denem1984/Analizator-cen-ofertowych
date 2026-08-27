const base=require('./live-combined-api-v05');
const {getPortalTotals}=require('./portal-counts');

async function run(payload={}){
  const data=await base.run(payload);
  const type=String(payload.propertyType||data.propertyType||'mieszkanie').toLowerCase();
  const isPlots=type.includes('dział')||type.includes('dzial');

  if(isPlots){
    const sources=(data.sources||[]).filter(source=>String(source.portal||'').toLowerCase()!=='otodom');
    const before=sources.flatMap(source=>source.offers||[]);
    const cross=base.dedupeOffers(before);
    data.sources=sources.map(source=>({...source,uniqueAfterCrossPortal:(source.offers||[]).length}));
    data.beforeCrossDedup=before.length;
    data.unique=cross.rows.length;
    data.duplicatesRemoved=cross.duplicates.length;
    data.duplicates=cross.duplicates;
    data.offers=cross.rows;
    data.filtered=before.length;
    data.accepted=cross.rows.length;
    return data;
  }

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

module.exports={...base,run};
