import assert from 'node:assert/strict'
import test from 'node:test'
import { doctorLabel } from '../src/lib/doctor-label.ts'

test('doctor labels remove only the trailing simulation suffix', () => {
  for (const name of ['张建中（训练模拟）', '张建中 (训练模拟)', '张建中（ 训练模拟 ） ']) assert.equal(doctorLabel(name), '张建中')
  assert.equal(doctorLabel('张建中'), '张建中')
  assert.equal(doctorLabel('张建中（皮肤科）'), '张建中（皮肤科）')
  assert.equal(doctorLabel('训练模拟说明'), '训练模拟说明')
})
