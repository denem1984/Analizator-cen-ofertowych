const GUS_FTS_BASE="https://geo.stat.gov.pl/api/fts";

function clean(v){return String(v||"").replace(/\s+/g," ").trim();}
function sameName(a,b){return clean(a).toLowerCase()===clean(b).toLowerCase();}

// GUS remains the primary resolver. These are authoritative fallbacks for
// ambiguous/intermittently missing city-gminas observed in production.
const FALLBACK_LOCATIONS={
  "olsztyn":{name:"Olsztyn",teryt:"2862011",simc:"0964465",wojewodztwo:"warmińsko-mazurskie",wojewodztwoTeryt:"28",powiat:"Olsztyn",powiatTeryt:"2862",gmina:"Olsztyn"},
  "ełk":{name:"Ełk",teryt:"2805011",simc:"0977670",wojewodztwo:"warmińsko-mazurskie",wojewodztwoTeryt:"28",powiat:"ełcki",powiatTeryt:"2805",gmina:"Ełk"},
  "elk":{name:"Ełk",teryt:"2805011",simc:"0977670",wojewodztwo:"warmińsko-mazurskie",wojewodztwoTeryt:"28",powiat:"ełcki",powiatTeryt:"2805",gmina:"Ełk"},
  "pisz":{name:"Pisz",teryt:"2816033",simc:"0977835",wojewodztwo:"warmińsko-mazurskie",wojewodztwoTeryt:"28",powiat:"piski",powiatTeryt:"2816",gmina:"Pisz"}
};

async function requestGus(path,body){
  const response=await fetch(`${GUS_FTS_BASE}${path}`,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify(body)});
  if(!response.ok){const text=await response.text().catch(()=>"");const error=new Error(`GUS FTS HTTP ${response.status}${text?` — ${text.slice(0,300)}`:""}`);error.httpStatus=response.status;throw error;}
  const data=await response.json();return Array.isArray(data)?data:[];
}

function findHit(candidates,name){
  return candidates.find(x=>{const s=x?.single||{},p=s?.record?.properties||{};return sameName(s.name,name)||sameName(p.gm_nazwa,name);})||null;
}

function toLocation(hit,name){
  const s=hit?.single,p=s?.record?.properties||{};if(!s||!p.gm_nazwa)return null;
  return {input:name,name:clean(p.gm_nazwa||s.name||name),teryt:String(p.gm_idteryt||s.teryt||""),simc:String(p.miejsc_idTERYT||s.simc||""),wojewodztwo:clean(p.woj_nazwa),wojewodztwoTeryt:String(p.woj_idteryt||""),powiat:clean(p.pow_nazwa),powiatTeryt:String(p.pow_idteryt||""),gmina:clean(p.gm_nazwa),source:"GUS TERYT/SIMC"};
}

function fallbackLocation(name){const fallback=FALLBACK_LOCATIONS[clean(name).toLowerCase()];return fallback?{input:name,...fallback,source:"GUS TERYT/SIMC fallback"}:null;}

async function resolveLocation(location){
  const name=clean(location);if(!name)throw new Error("Brak lokalizacji.");
  let lastError=null;
  for(const path of ["/gc/jpa","/gc/gmi"]){
    try{const candidates=await requestGus(path,{reqs:[{gm_nazwa:name}]});const hit=findHit(candidates,name);const resolved=toLocation(hit,name);if(resolved)return resolved;}catch(error){lastError=error;}
  }
  const fallback=fallbackLocation(name);if(fallback)return fallback;
  if(lastError)throw lastError;
  throw new Error(`Nie znaleziono lokalizacji: ${name}`);
}

module.exports={resolveLocation};
