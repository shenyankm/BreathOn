import { test, expect, chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

test('installed Android app: login, all routes, lessons, native Back, SQLite preferences and logout', async () => {
  test.skip(!process.env.E2E_ANDROID_CDP, 'Provide a forwarded debug WebView CDP endpoint')
  test.setTimeout(process.env.E2E_LIVE==='1'?600_000:180_000)
  const browser = await chromium.connectOverCDP(process.env.E2E_ANDROID_CDP!, { noDefaults: true })
  const page = browser.contexts()[0].pages().find(p => p.url().startsWith('http://127.0.0.1:5187/_android/index.html'))
  expect(page, 'Attach only to the isolated local acceptance APK').toBeTruthy()
  const errors: string[] = []; page!.on('pageerror', e => errors.push(e.message))
  try {
    // Reset only the two disposable accounts so repeated runs can verify isolation.
    await page!.evaluate(async()=>{location.hash='home';for(const account of ['e2e-a','e2e-b'])await (window as any).__TAURI_INTERNALS__.invoke('save_training_preference',{account,experience:'practice'})})
    await page!.reload()
    await page!.locator('input[name="username"]').fill('e2e-a')
    await page!.locator('input[name="password"]').fill('local-e2e-only-password')
    await page!.getByRole('button', { name: '登录', exact: true }).click()
    const nav = page!.getByRole('navigation', { name: '主导航', exact: true })
    await expect(nav).toBeVisible()
    for (const name of ['训练','教练','我的','首页']) {
      await nav.getByRole('link', { name, exact: true }).click()
      await expect(nav.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current','page')
      await expect(page!.locator('section.screen.active').first()).toBeVisible()
    }
    const course=await page!.evaluate(async()=> (await (await fetch('/api/curriculum')).json()).levels.flatMap((l: any)=>l.lessons)[0])
    for(const route of ['level/L1','level/L2','level/L3','level/L4',`lesson/${course.id}`,'doctors','pick','workspace','products','library','audiences','policies','audit','settings','records','visits']) {
      await page!.evaluate(route => { location.hash=route },route)
      await expect(page!.locator('main')).toBeVisible()
      await expect(page!.getByText('正在加载页面…')).toHaveCount(0)
      await expect(page!.locator('main [role="alert"]')).toHaveCount(0)
    }
    await page!.evaluate(id=>{location.hash=`lesson/${id}`},course.id)
    const completed=page!.getByRole('button',{name:'已完成 · 点击取消',exact:true})
    if(await completed.isVisible()) await completed.click()
    await page!.getByRole('button',{name:'标记完成',exact:true}).click()
    await expect(completed).toBeVisible()
    await page!.reload(); await expect(completed).toBeVisible()
    if(process.env.E2E_ADB) {
      execFileSync(process.env.E2E_ADB,['-s',process.env.E2E_SERIAL??'emulator-5554','shell','input','keyevent','4'])
      await expect(page!).toHaveURL(new RegExp(`#level/${course.level}$`))
      await test.info().attach('native-ui-tree',{body:execFileSync(process.env.E2E_ADB,['-s',process.env.E2E_SERIAL??'emulator-5554','exec-out','uiautomator','dump','/dev/tty']),contentType:'text/xml'})
    }
    await page!.evaluate(()=>{location.hash='coach'})
    await page!.getByRole('button',{name:'实战练习',exact:true}).click()
    await expect(page!.getByRole('button',{name:'实战练习',exact:true})).toHaveAttribute('aria-pressed','true')
    await page!.reload()
    await expect(page!.getByRole('button',{name:'实战练习',exact:true})).toHaveAttribute('aria-pressed','true')
    await page!.evaluate(()=>{location.hash='me'})
    await page!.getByRole('button',{name:'退出登录',exact:true}).click()
    await page!.getByRole('button',{name:'取消',exact:true}).click()
    await expect(nav).toBeVisible()
    await page!.getByRole('button',{name:'退出登录',exact:true}).click()
    await page!.getByRole('button',{name:'确认退出',exact:true}).click()
    await page!.locator('input[name="username"]').fill('e2e-b')
    await page!.locator('input[name="password"]').fill('local-e2e-only-password')
    await page!.getByRole('button',{name:'登录',exact:true}).click()
    await expect(nav).toBeVisible()
    await page!.evaluate(()=>{location.hash='coach'})
    await expect(page!.getByRole('button',{name:'辅助练习',exact:true})).toHaveAttribute('aria-pressed','true')
    if(process.env.E2E_ADB) {
      const adb=process.env.E2E_ADB,serial=process.env.E2E_SERIAL??'emulator-5554'
      execFileSync(adb,['-s',serial,'shell','pm','clear-permission-flags','cloud.openwook.medvisit.e2e','android.permission.RECORD_AUDIO','user-set','user-fixed'])
      execFileSync(adb,['-s',serial,'shell','pm','revoke','cloud.openwook.medvisit.e2e','android.permission.RECORD_AUDIO'])
      await page!.getByRole('button',{name:'开始本轮对话',exact:true}).click()
      let target:number[]=[]
      await expect.poll(()=>{
        const xml=execFileSync(adb,['-s',serial,'exec-out','uiautomator','dump','/dev/tty']).toString()
        const node=[...xml.matchAll(/<node\b[^>]*>/g)].map(m=>m[0]).find(n=>/resource-id="[^"]*:id\/permission_deny_button"/.test(n))
        const bounds=node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
        if(bounds)target=bounds.slice(1).map(Number)
        return target.length
      },{timeout:20_000}).toBe(4)
      execFileSync(adb,['-s',serial,'shell','input','tap',String(Math.floor((target[0]+target[2])/2)),String(Math.floor((target[1]+target[3])/2))])
      await expect(page!.getByRole('alert').first()).toBeVisible()
      await page!.evaluate(()=>{location.hash='coach'})
      await page!.reload()
      await expect(page!.getByRole('button',{name:'开始本轮对话',exact:true})).toBeEnabled()
    }
    if(process.env.E2E_LIVE==='1') {
      const audioPath=path.resolve('test-results/synthetic-input.pcm')
      if(!existsSync(audioPath))execFileSync('uv',['run','--directory','../backend','--locked','python','-m','tools.e2e_audio','--live','--output',audioPath],{timeout:60_000})
      const audio=readFileSync(audioPath).toString('base64')
      for(const mode of ['辅助练习','实战练习']) {
        await page!.evaluate(()=>{location.hash='coach'});await page!.reload()
        // Only microphone input is a synthetic fixture. WebAudio, AudioWorklet, playback, WebSocket and providers are real.
        await page!.evaluate(audio=>{
          const w=window as any;w.__e2eEvents=[];w.__e2eAudioBytes=0
          const Native=window.WebSocket
          w.WebSocket=class extends Native {
            constructor(url:string|URL,protocols?:string|string[]){super(url,protocols);this.addEventListener('message',({data})=>{
              const event=JSON.parse(data);if(event.type==='audio')w.__e2eAudioBytes+=atob(event.audio).length;else w.__e2eEvents.push(event)
            })}
          }
          navigator.mediaDevices.getUserMedia=async()=>{
            const context=new AudioContext({sampleRate:16000});w.__e2eInput=context
            const raw=atob(audio),buffer=context.createBuffer(1,raw.length/2,16000),samples=buffer.getChannelData(0)
            for(let i=0;i<samples.length;i++){const v=raw.charCodeAt(i*2)|(raw.charCodeAt(i*2+1)<<8);samples[i]=(v>=32768?v-65536:v)/32768}
            const source=context.createBufferSource(),destination=context.createMediaStreamDestination()
            source.buffer=buffer;source.connect(destination);await context.resume();source.start(context.currentTime+6)
            return destination.stream
          }
        },audio)
        await page!.getByRole('button',{name:mode,exact:true}).click()
        await page!.getByRole('button',{name:'开始本轮对话',exact:true}).click()
        await expect.poll(()=>page!.evaluate(()=> (window as any).__e2eEvents.some((e:any)=>e.type==='transcript'&&e.role==='trainee'&&e.final&&e.text.trim())),{timeout:90_000,intervals:[500]}).toBe(true)
        await expect.poll(()=>page!.evaluate(()=> (window as any).__e2eAudioBytes),{timeout:30_000}).toBeGreaterThan(0)
        await page!.getByRole('button',{name:'关闭医生声音',exact:true}).click()
        await page!.getByRole('button',{name:'开启医生声音',exact:true}).click()
        await page!.getByRole('button',{name:'静音麦克风',exact:true}).click()
        await page!.getByRole('button',{name:'取消静音',exact:true}).click()
        await page!.getByRole('button',{name:'结束演练',exact:true}).click()
        await expect.poll(()=>page!.evaluate(()=> (window as any).__e2eEvents.find((e:any)=>e.type==='ended')?.saved),{timeout:90_000,intervals:[500,1000]}).toBe(true)
        const evidence=await page!.evaluate(()=>({events:(window as any).__e2eEvents,outputAudioBytes:(window as any).__e2eAudioBytes,syntheticMicrophone:true}))
        const ready=evidence.events.find((e:any)=>e.type==='ready')
        const record=await page!.evaluate(async id=>(await fetch(`/api/sessions/${id}`)).json(),ready.session_id)
        expect(record.capture_status).toBe('completed')
        expect(record.analysis_status).toBe('completed')
        expect(record.summary_card.total).toBeNull()
        await test.info().attach(`android-${mode}`,{body:JSON.stringify(evidence),contentType:'application/json'})
        await expect(page!.getByRole('link',{name:'查看完整复盘与原话',exact:true})).toBeVisible()
        await page!.getByRole('link',{name:'查看完整复盘与原话',exact:true}).click()
        await expect(page!).toHaveURL(/#records\?session=/)
        await page!.evaluate(async()=>{await (window as any).__e2eInput.close()})
      }
    }
    await page!.screenshot({path:test.info().outputPath('android.png'),fullPage:true})
    expect(errors).toEqual([])
  } catch(error) {
    await page!.screenshot({path:test.info().outputPath('android-failure.png'),fullPage:true}).then(body=>test.info().attach('android-failure',{body,contentType:'image/png'})).catch(()=>{})
    throw error
  } finally {
    try {
      const end=page!.getByRole('button',{name:'结束演练',exact:true})
      if(await end.isVisible())await end.click()
      await page!.evaluate(async()=>{const input=(window as any).__e2eInput;if(input&&input.state!=='closed')await input.close()})
    } finally { await browser.close() }
  }
})
