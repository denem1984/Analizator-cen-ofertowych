const { searchCommercial } = require('./parser-commercial-v07');
(async()=>{
  const location='Olsztyn', area=100, tolerance=50, radius=0;
  try {
    const r=await searchCommercial({location,area,radius,tolerance});
    console.log('NO_DIAGNOSTIC_START');
    console.log(JSON.stringify(r,null,2));
    console.log('NO_DIAGNOSTIC_END');
  } catch(e) {
    console.error('NO_DIAGNOSTIC_ERROR', e.stack || e.message || e);
    process.exitCode=1;
  }
})();
