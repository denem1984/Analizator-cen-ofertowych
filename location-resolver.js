const GUS_FTS_BASE="https://geo.stat.gov.pl/api/fts";

function clean(v){return String(v||"").replace(/\s+/g," ").trim();}
function sameName(a,b){return clean(a).toLowerCase()===clean(b).toLowerCase();}

// Some city-gminas are intermittently not returned by the GUS FTS
// autocomplete endpoints even though they are valid TERYT/SIMC locations.
// Keep a small authoritative fallback for those cases and continue using
// GUS as the primary resolver for all other locations.
const FALLBACK_LOCATIONS={
  "olsztyn":{
    name:"Olsztyn",
    teryt:"2862011",
    simc:"0964465",
    wojewodztwo:"warmińsko-mazurskie",
    wojewodztwoTeryt:"28",
    powiat:"Olsztyn",
    powiatTeryt:"2862",
    gmina:"Olsztyn"
  }
};

async function requestGus(path,body){
  const response=await fetch(`${GUS_FTS_BASE}${path}`,{
    method:"POST",
    headers:{"Content-Type":"application/json","Accept":"application/json"},
    body:JSON.stringify(body)
  });
  if(!response.ok){
    const text=await response.text().catch(()=>"");
    const error=new Error(`GUS FTS HTTP ${response.status}${text?` — ${text.slice(0,300)}`:""}`);
    error.httpStatus=response.status;
    throw error;
  }
  const data=await response.json();
  return Array.isArray(data)?data:[];
}

function findHit(candidates,name){
  return candidates.find(x=>{
    const s=x?.single||{},p=s?.record?.properties||{};
    return sameName(s.name,name)||sameName(p.gm_nazwa,name);
  })||candidates[0];
}

function toLocation(hit,name){
  const s=hit?.single;
  const p=s?.record?.properties||{};
  if(!s||!p.gm_nazwa) return null;
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

function fallbackLocation(name){
  const fallback=FALLBACK_LOCATIONS[clean(name).toLowerCase()];
  if(!fallback) return null;
  return {input:name,...fallback,source:"GUS TERYT/SIMC fallback"};
}

async function resolveLocation(location){
  const name=clean(location);
  if(!name) throw new Error("Brak lokalizacji.");

  // JPA is the primary resolver. If it returns no useful hit, retry through
  // the dedicated municipality endpoint (/gmi), which is more reliable for
  // city-gminas such as Olsztyn.
  let candidates=[];
  let lastError=null;
  for(const path of ["/gc/jpa","/gc/gmi"]){
    try{
      candidates=await requestGus(path,{reqs:[{gm_nazwa:name}]});
      const hit=findHit(candidates,name);
      const resolved=toLocation(hit,name);
      if(resolved) return resolved;
    }catch(error){
      lastError=error;
    }
  }

  const fallback=fallbackLocation(name);
  if(fallback) return fallback;

  if(lastError && !candidates.length) throw lastError;
  throw new Error(`Nie znaleziono lokalizacji: ${name}`);
}

module.exports={resolveLocation};
