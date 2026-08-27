// Production wrapper: public UI + compatibility proxy.
const http=require('http');const fs=require('fs');const path=require('path');const{URL}=require('url');const{resolveLocation}=require('./location-resolver');const{runApartmentDiagnostic}=require('./combined-apartment-diagnostics');
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
const proxy=http.createServer(async(req,res)=>{
 const pathname=(req.url||'').split('?')[0];
 if(pathname==='/'||pathname==='/index.html'){try{const html=fs.readFileSync(indexPath,'utf8');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html);}catch(e){res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Nie można wczytać aplikacji: '+e.message);}}
 if(pathname==='/api/location-suggestions'&&req.method==='GET'){try{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);return sendJson(res,200,await suggestLocations(url.searchParams.get('q')||''));}catch{return sendJson(res,200,[]);}}
 if(pathname==='/api/resolve-location'&&req.method==='GET'){try{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);return sendJson(res,200,await resolveLocation(url.searchParams.get('location')||''));}catch(e){return sendJson(res,400,{error:e.message||'Nie udało się rozpoznać lokalizacji.'});}}
 if(pathname==='/api/live/combined-diagnostic'&&(req.method==='GET'||req.method==='POST')){try{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);return sendJson(res,200,await runApartmentDiagnostic({location:url.searchParams.get('location')||'Olsztyn',area:Number(url.searchParams.get('area')||62),tolerance:Number(url.searchParams.get('tolerance')||10),radius:Number(url.searchParams.get('radius')||0)}));}catch(e){return sendJson(res,500,{error:e.message||'Błąd diagnostyki serwera'});}}
 if(pathname==='/api/live/combined'&&(req.method==='GET'||req.method==='POST')){const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);const type=String(url.searchParams.get('propertyType')||'mieszkanie').toLowerCase();if(type==='mieszkanie'){try{return sendJson(res,200,await runApartmentDiagnostic({location:url.searchParams.get('location')||'Olsztyn',area:Number(url.searchParams.get('area')||62),tolerance:Number(url.searchParams.get('tolerance')||10),radius:Number(url.searchParams.get('radius')||0)}));}catch(e){return sendJson(res,500,{error:e.message||'Błąd serwera'});}}}
 const options={hostname:'127.0.0.1',port:upstreamPort,path:req.url,method:req.method,headers:req.headers};const p=http.request(options,r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});p.on('error',e=>{res.writeHead(502,{'Content-Type':'text/plain; charset=utf-8'});res.end('Proxy error: '+e.message);});req.pipe(p);
});
proxy.listen(publicPort,'0.0.0.0',()=>console.log('PUBLIC WRAPPER listening on '+publicPort));
