// The trades surface keeps the trader's page open until nothing of its leaf wallet is moving: a
// refresh not done and not released, or a coin on its way.
//
//   node --test regression/checks/trades.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { stillMoving } from './trades.mjs'

test('a refresh not done, or a coin moving, keeps the page open', () => {
  assert.deepEqual(stillMoving({ participations: [{ participation: '8e671547088b0000', state: 'pending' }], coins: [{ state: 'live' }] }),
    { participations: ['8e671547088b pending'], coins: 0 })
  assert.deepEqual(stillMoving({ participations: [], coins: [{ state: 'forfeited' }, { state: 'live' }, { state: 'sending' }] }),
    { participations: [], coins: 2 })
})

test('done or released refreshes and live coins let it close', () => {
  const left = stillMoving({ participations: [{ participation: 'a', state: 'released' }, { participation: 'b', state: 'void' },
    { participation: 'c', state: 'forfeiting', released: true }], coins: [{ state: 'live' }, { state: 'spent' }] })
  assert.deepEqual(left, { participations: [], coins: 0 })
})

test('a page whose leaf wallet cannot be read says so', () => {
  assert.equal(stillMoving(null), null)
  assert.deepEqual(stillMoving({}), { participations: [], coins: 0 })
})
