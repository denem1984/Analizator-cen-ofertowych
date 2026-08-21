const GUS_FTS_URL="https://geo.stat.gov.pl/api/fts/gc/jpa";

function clean(v){return String(v||"").replace(/\s+/g," ").trim();}

async function resolveLocation(location){
  const name=clean(location);
  if(!name) throw new Error("Brak lokalizacji.");

  // GUS FTS /gc/jpa accepts the GcReqJpa body. Keep the request minimal:
  // the previous payload added useExtServiceIfNotFound, which is not part of
  // the documented JPA request and caused HTTP 400 from GUS.
  const response=await fetch(GUS_FTS_URL,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Accept":"application/json"
    },
    body:JSON.stringify({reqs:[{gm_nazwa:name}]})
  });

  if(!response.ok){
    const body=await response.text().catch(()=>"");
    throw new Error(`GUS FTS HTTP ${response.status}${body?` — ${body.slice(0,300)}`:""}`);
  }

  const data=await response.json();
  const candidates=Array.isArray(data)?data:[];

  const exact=candidates.find(x=>{
    const s=x?.single||{};
    return clean(s.name).toLowerCase()===name.toLowerCase() ||
      clean(s.record?.properties?.gm_nazwa).toLowerCase()===name.toLowerCase();
  });
  const hit=exact||candidates[0];
  const s=hit?.single;
  const p=s?.record?.properties||{};

  if(!s||!p.gm_nazwa) throw new Error(`Nie znaleziono lokalizacji: ${name}`);

  return {
    input:name,
    name:clean(p.gm_nazwa||s.name||name),
    teryt:String(p.gm_idteryt||s.teryt||""),
    simc:String(p.miejsc_idTERYT||s.simc||""),
    wojewodztwo:clean(p.woj_nazwa),
    wojewodztwoTeryt:String(p.woj_idteryt||""),
    powiat:clean(p.pow_nazwa),
    powiatTeryt:String(p.pow_idteryt||""),
    gmina:clean(p.gm_nazwa),
    source:"GUS TERYT/SIMC"
  };
}

module.exports={resolveLocation};
