// Production wrapper: public UI + compatibility proxy.
const http=require('http');const fs=require('fs');const path=require('path');const{URL}=require('url');const{resolveLocation}=require('./location-resolver');const{runApartmentDiagnostic}=require('./combined-apartment-diagnostics');const{run:runCombinedBase,dedupeOffers}=require('./live-combined-api-v05');
const upstreamPort=10001;const publicPort=Number(process.env.PORT)||10000;process.env.PORT=String(upstreamPort);require('./compat-server.js');
const indexPath=path.join(__dirname,'index.html');

async function suggestLocations(query){
 const q=String(query||'').trim();if(q.length<2)return[];
 const result=[];const seen=new Set();
 try{const exact=await resolveLocation(q);if(exact?.name){const key=exact.name.toLocaleLowerCase('pl-PL');seen.add(key);result.push({name:exact.name,teryt:String(exact.teryt||''),powiat:String(exact.powiat||''),wojewodztwo:String(exact.wojewodztwo||'')});}}catch{}
 try{
  const url=new URL('https://geo.stat.gov.pl/api/fts/ref/qq');url.searchParams.set('f','geojson');url.searchParams.set('q',q);url.searchParams.set('cnt','50');url.searchParams.set('idx','jpa');url.searchParams.set('top','and');
  const response=await fetch(url,{headers:{Accept:'application/json'}});if(!response.ok)throw new Error(`GUS TERYT HTTP ${response.status}`);
  const data=await response.json();const features=Array.isArray(data?.features)?data.features:[];
  const rows=[];for(const feature of features){const p=feature?.properties||feature?.record?.properties||{};const name=String(p.gm_nazwa||p.jpa_nazwa||feature?.name||'').trim();if(!name)continue;const key=name.toLocaleLowerCase('pl-PL');if(seen.has(key))continue;seen.add(key);rows.push({name,teryt:String(p.gm_idteryt||p.teryt||''),powiat:String(p.pow_nazwa||'').trim(),wojewodztwo:String(p.woj_nazwa||'').trim()});}
  rows.sort((a,b)=>{const ae=a.name.toLocaleLowerCase('pl-PL')===q.toLocaleLowerCase('pl-PL'),be=b.name.toLocaleLowerCase('pl-PL')===q.toLocaleLowerCase('pl-PL');return Number(be)-Number(ae)||a.name.localeCompare(b.name,'pl');});return result.concat(rows).slice(0,12);
 }catch{return result.slice(0,12)}
}
function sendJson(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function preparePlotResult(data){
 const sources=(Array.isArray(data.sources)?data.sources:[]).filter(s=>String(s.portal||'').toLowerCase()!=='otodom');
 const before=sources.flatMap(s=>Array.isArray(s.offers)?s.offers:[]);
 const cross=dedupeOffers(before);
 return{...data,version:'0.5.2-plots-no-otodom',sources:sources.map(s=>({...s,uniqueAfterCrossPortal:(s.offers||[]).length,internalDuplicatesRemoved:0,acceptedAfterDedup:(s.offers||[]).length})),beforeCrossDedup:before.length,unique:cross.rows.length,duplicatesRemoved:cross.duplicates.length,duplicates:cross.duplicates,offers:cross.rows};
}
const uiPatch=`<script>
(function(){
 const isPlots=()=>String(window.lastData?.propertyType||'').toLowerCase().includes('dział')||String(window.lastData?.propertyType||'').toLowerCase().includes('dzial');
 const originalRenderOffers=window.renderOffers;
 window.renderOffers=function(){
  const data=window.lastData||{},offers=[...currentOffers].sort((a,b)=>{const av=sortValue(a,sortKey,data),bv=sortValue(b,sortKey,data);if(typeof av==='number'&&typeof bv==='number'){if(Number.isNaN(av)&&Number.isNaN(bv))return 0;if(Number.isNaN(av))return 1;if(Number.isNaN(bv))return -1;return(av-bv)*sortDir}return String(av).localeCompare(String(bv),'pl',{numeric:true,sensitivity:'base'})*sortDir});
  const arrows={type:'Typ',location:'Lokalizacja / adres',source:'Źródło',price:'Cena',area:'Powierzchnia',priceM2:'Cena/m²'};
  const th=k=>`<th class="${sortKey===k?(sortDir===1?'sort-asc':'sort-desc'):''}" onclick="sortOffers('${k}')">${arrows[k]}<span class="arrow">${sortKey===k?(sortDir===1?'▲':'▼'):'↕'}</span></th>`;
  $('offerCount').textContent=offers.length+' ofert';
  $('offers').innerHTML=`<div class="offers-wrap"><table class="offers"><thead><tr><th>LP</th>${th('type')}${th('location')}${th('source')}<th>URL</th>${th('price')}${th('area')}${th('priceM2')}</tr></thead><tbody>${offers.map((o,i)=>{const loc=[o.locality,o.street].filter(Boolean).join(', ')||o.location||'—';return `<tr><td>${i+1}</td><td>${esc(o.type||data.propertyType||'')}</td><td>${esc(loc)}</td><td>${esc(o.source||o.portal||'—')}</td><td><a href="${esc(o.url||'#')}" target="_blank" rel="noopener">Otwórz</a></td><td class="price">${fmtMoney(o.price)}</td><td>${fmtNum(o.area)} m²</td><td class="pm2">${fmtM2(o.priceM2)}</td></tr>`}).join('')}</tbody></table></div>`;
 };
 window.render=function(data){
  window.lastData=data;$('results').classList.remove('hidden');$('message').classList.add('hidden');
  const sources=Array.isArray(data.sources)?data.sources:[];currentOffers=Array.isArray(data.offers)?data.offers:[];
  const sum=field=>sources.reduce((a,s)=>a+Number(s[field]||0),0);
  const plots=isPlots();
  const filtered=plots?Number(data.beforeCrossDedup||0):sum('filtered');
  const duplicates=plots?Number(data.duplicatesRemoved||0):sum('internalDuplicatesRemoved');
  const accepted=plots?Number(data.unique||currentOffers.length):sources.reduce((a,s)=>a+Number(s.acceptedAfterDedup??Math.max(0,Number(s.filtered||0)-Number(s.internalDuplicatesRemoved||0))),0);
  $('filtered').textContent=fmtNum(filtered);$('duplicates').textContent=fmtNum(duplicates);$('accepted').textContent=fmtNum(accepted);
  const areas=currentOffers.map(o=>Number(o.area)).filter(Number.isFinite);$('range').innerHTML=areas.length?`Zakres powierzchni: <strong>${fmtNum(Math.min(...areas))} m² – ${fmtNum(Math.max(...areas))} m²</strong>`:'Brak ofert w wyniku.';
  $('queryInfo').textContent=data.filterLabel?`${esc(data.location||'')} · ${esc(data.propertyType||'')} · ${esc(data.filterLabel)} · promień ${fmtNum(data.radius)} km`:`${esc(data.location||'')} · ${esc(data.propertyType||'')} · promień ${fmtNum(data.radius)} km`;
  $('sources').innerHTML=sources.map(s=>`<div class="source"><h3>${esc(s.portal||s.source||'Źródło')}</h3><div>ilość ofert po filtrze: <b>${fmtNum(s.filtered??0)}</b></div><div>usunięte duplikaty: <b>${fmtNum(s.internalDuplicatesRemoved||0)}</b></div><div>przyjęto: <b>${fmtNum(s.acceptedAfterDedup??Math.max(0,Number(s.filtered||0)-Number(s.internalDuplicatesRemoved||0)))}</b></div></div>`).join('');
  const pill=document.querySelector('.section-title .pill');if(pill)pill.textContent=sources.length+' źródeł danych';sortKey=null;sortDir=1;window.renderOffers();
 };
})();
</script>`;
const proxy=http.createServer(async(req,res)=>{
 const pathname=(req.url||'').split('?')[0];
 if(pathname==='/'||pathname==='/index.html'){try{let html=fs.readFileSync(indexPath,'utf8');html=html.replace('</body>',uiPatch+'</body>');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html);}catch(e){res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Nie można wczytać aplikacji: '+e.message);}}
 if(pathname==='/api/location-suggestions'&&req.method==='GET'){try{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);return sendJson(res,200,await suggestLocations(url.searchParams.get('q')||''));}catch{return sendJson(res,200,[]);}}
 if(pathname==='/api/resolve-location'&&req.method==='GET'){try{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);return sendJson(res,200,await resolveLocation(url.searchParams.get('location')||''));}catch(e){return sendJson(res,400,{error:e.message||'Nie udało się rozpoznać lokalizacji.'});}}
 if(pathname==='/api/live/combined-diagnostic'&&(req.method==='GET'||req.method==='POST')){try{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);return sendJson(res,200,await runApartmentDiagnostic({location:url.searchParams.get('location')||'Olsztyn',area:Number(url.searchParams.get('area')||62),tolerance:Number(url.searchParams.get('tolerance')||10),radius:Number(url.searchParams.get('radius')||0)}));}catch(e){return sendJson(res,500,{error:e.message||'Błąd diagnostyki serwera'});}}
 if(pathname==='/api/live/combined'&&(req.method==='GET'||req.method==='POST')){const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);const type=String(url.searchParams.get('propertyType')||'mieszkanie').toLowerCase();if(type.includes('dział')||type.includes('dzial')){try{const data=await runCombinedBase({location:url.searchParams.get('location')||'Olsztyn',area:Number(url.searchParams.get('area')||1000),tolerance:Number(url.searchParams.get('tolerance')||10),radius:Number(url.searchParams.get('radius')||0),propertyType:'działka'});return sendJson(res,200,preparePlotResult(data));}catch(e){return sendJson(res,500,{error:e.message||'Błąd serwera działek'});}}if(type==='mieszkanie'){try{return sendJson(res,200,await runApartmentDiagnostic({location:url.searchParams.get('location')||'Olsztyn',area:Number(url.searchParams.get('area')||62),tolerance:Number(url.searchParams.get('tolerance')||10),radius:Number(url.searchParams.get('radius')||0)}));}catch(e){return sendJson(res,500,{error:e.message||'Błąd serwera'});}}}
 const options={hostname:'127.0.0.1',port:upstreamPort,path:req.url,method:req.method,headers:req.headers};const p=http.request(options,r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});p.on('error',e=>{res.writeHead(502,{'Content-Type':'text/plain; charset=utf-8'});res.end('Proxy error: '+e.message);});req.pipe(p);
});
proxy.listen(publicPort,'0.0.0.0',()=>console.log('PUBLIC WRAPPER listening on '+publicPort));
