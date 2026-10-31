const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL});
 const page = await browser.newPage({viewport:{width:393,height:851}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('file://'+__dirname+'/www/index.html');
 assert(await page.locator('.logo').evaluate(img=>img.complete&&img.naturalWidth>0));
 for (const name of ['home','measure','records','insight','profile']) {
  await page.locator(`[data-target="${name}"]`).click();
  assert(await page.locator(`[data-screen="${name}"]`).isVisible());
 }
 await page.evaluate(()=>go('measure'));
 await page.locator('#measureButton').click();
 await page.waitForFunction(()=>document.getElementById('measureButton').textContent==='查看本次反馈');
 await page.locator('#measureButton').click();
 assert(await page.locator('#consentModal').isVisible());
 await page.getByRole('button',{name:'仅保存在本机',exact:true}).click();
 assert.equal(await page.locator('#measureButton').textContent(),'再次检测');
 assert(await page.locator('#shareSwitch').evaluate(el=>el.classList.contains('on')));
 await page.evaluate(()=>openSettings());
 assert.equal(await page.evaluate(()=>appBack()),true);
 assert(!(await page.locator('#settingsModal').isVisible()));
 assert.equal(await page.evaluate(()=>appBack()),true);
 assert(await page.locator('[data-screen="home"]').isVisible());
 assert.equal(await page.evaluate(()=>appBack()),false);
 assert.deepEqual(errors,[]);
 await browser.close();console.log('PASS: five screens, measurement, consent, repeat action, modal and home Back; no page errors');
})().catch(e=>{console.error(e);process.exit(1)});
