// Rasterise SVG jobs for scripts/brand.py: node scripts/render.js jobs.json
const {chromium}=require('playwright');const fs=require('fs');
(async()=>{const jobs=JSON.parse(fs.readFileSync(process.argv[2]));const b=await chromium.launch();
for(const j of jobs){const p=await b.newPage({viewport:{width:j.w,height:j.h},deviceScaleFactor:1});
await p.setContent(`<html><body style="margin:0;background:transparent">${j.svg}</body></html>`);
await p.evaluate(()=>document.fonts.ready);await p.screenshot({path:j.out,omitBackground:!j.opaque,clip:{x:0,y:0,width:j.w,height:j.h}});await p.close();}
await b.close();})();
