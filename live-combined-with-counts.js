const base=require('./live-combined-api-v05');
const {getPortalTotals}=require('./portal-counts');

async function run(payload={}){
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

module.exports={...base,run};
