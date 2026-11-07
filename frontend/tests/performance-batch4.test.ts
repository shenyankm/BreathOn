import assert from 'node:assert/strict'
import test from 'node:test'
import { nextAction } from '../src/lib/learning.ts'

test('reused quote normalization respects role, final state, duplicate IDs and changes between calls',()=>{
  const quote='先核对原文适用人群再确认安排', other='只有医生说过的完整原话'
  const messages=[{id:'u',role:'doctor',final:true,text:other},{id:'u',role:'trainee',final:false,text:other},{id:'u',role:'trainee',final:true,text:quote.split('').join(' ')}]
  const record:any={messages,coaching:[{final_report:true,points:['确认下一步'],assessment:{dimensions:[{key:'d',label:'沟通',score:1,utterances:[{message_id:'u',quote:other},{message_id:'u',quote:'不存在的六字原话'},{message_id:'u',quote}]}]}}]}
  assert.equal(nextAction(record).quote,quote)
  assert.equal(record.messages,messages)
  messages[2].text='学员已经更正内容'
  assert.equal(nextAction(record).quote,undefined)
  record.coaching[0].superseded=true
  assert.equal(nextAction(record).scorable,false)
})
