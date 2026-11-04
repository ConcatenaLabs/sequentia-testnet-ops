// A browser left on the suite's profile is found and stopped; nothing else is (lib/suite.mjs
// browsersOn, stopBrowsersOn). Linux only: it reads /proc.
//
//   node regression/lib/browsers.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browsersOn, stopBrowsersOn, sleep } from './suite.mjs'

if (process.platform !== 'linux') { console.log('SKIP: reads /proc'); process.exit(0) }
const dir = mkdtempSync(join(tmpdir(), 'browsers-test-'))
const exe = (name) => { const f = join(dir, name); writeFileSync(f, '#!/bin/bash\nwhile :; do sleep 60; done\n'); chmodSync(f, 0o755); return f }
const chromium = exe('chromium-standin'), other = exe('not-a-browser')
// Like Chromium, this one rewrites its process title into one string joined by spaces.
const retitled = join(dir, 'chromium-retitled')
writeFileSync(retitled, `#!/usr/bin/env node\nprocess.title = 'chrome ' + process.argv.slice(2).join(' ')\nsetInterval(() => {}, 1 << 30)\n`); chmodSync(retitled, 0o755)
const profile = join(dir, 'profile-trades')
const start = (bin, args) => { const p = spawn(bin, args, { stdio: 'ignore', detached: true }); p.unref(); return p }
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

const left = start(chromium, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0'])
const leftRetitled = start(retitled, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0'])
const elsewhere = start(chromium, ['--headless=new', `--user-data-dir=${profile}-other`])
const notBrowser = start(other, [`--user-data-dir=${profile}`])
try {
  await sleep(300)
  const want = [left.pid, leftRetitled.pid].sort((a, b) => a - b)
  assert.deepEqual(browsersOn(profile).map((b) => b.pid).sort((a, b) => a - b), want, 'only the browsers on this very profile, retitled or not')
  const stopped = await stopBrowsersOn(profile, { graceMs: 500 })
  assert.deepEqual(stopped.sort((a, b) => a - b), want)
  await sleep(200)
  assert.equal(alive(left.pid), false, 'the leftover browser is stopped')
  assert.equal(alive(leftRetitled.pid), false, 'the retitled one too')
  assert.equal(alive(elsewhere.pid), true, 'a browser on another profile is left running')
  assert.equal(alive(notBrowser.pid), true, 'a process that is no browser is left running')
  assert.deepEqual(await stopBrowsersOn(profile, { graceMs: 500 }), [], 'nothing left: nothing stopped')
  console.log('browsersOn / stopBrowsersOn: ok')
} finally {
  for (const p of [left, leftRetitled, elsewhere, notBrowser]) { try { process.kill(p.pid, 'SIGKILL') } catch {} }
  rmSync(dir, { recursive: true, force: true })
}
