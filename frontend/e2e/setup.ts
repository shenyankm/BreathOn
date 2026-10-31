import { request } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { isAppDrug } from '../src/lib/app-drugs'

export default async function setup() {
  const context=await request.newContext({baseURL:'http://127.0.0.1:5187',extraHTTPHeaders:{Origin:'http://127.0.0.1:5187'}})
  try {
    const login=await context.post('/api/auth/login',{data:{username:'e2e-admin',password:'local-e2e-only-password'}})
    if(!login.ok())throw new Error('E2E administrator login failed')
    mkdirSync('test-results/.auth',{recursive:true})
    await context.storageState({path:path.resolve('test-results/.auth/admin.json')})
    const drugs=await (await context.get('/api/catalog/drug')).json()
    if(!drugs.some(isAppDrug)) {
      // Disposable test catalogue entry; no medical claims or production publication.
      const response=await context.post('/api/catalog/drug',{data:{name:'玛仕度肽注射液',brand:'信尔美',ownership:'company',practice_departments:['内分泌科']}})
      if(!response.ok())throw new Error(`E2E drug fixture: ${await response.text()}`)
      const drug=await response.json()
      const published=await context.post(`/api/catalog/drug/${drug.id}/publish`,{data:{version:drug.version}})
      if(!published.ok())throw new Error(`E2E drug publication: ${await published.text()}`)
    }
  } finally { await context.dispose() }
}
