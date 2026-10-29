// The suite's frame: lines, results, screenshots, and the one browser.
//
// A line is one capability a person relies on, written down in CAPABILITIES.md with the same id.
// Each check returns { ok, detail } or throws; a throw is a failure with its message as the
// detail. Every failure is screenshotted. A line that cannot run here (no funded wallet, a surface
// with no live page) is SKIP with its reason, never PASS.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Phone: a 390 x 844 touch screen; desktop: 1440 x 1000.
export const WIDTHS = {
  desktop: { width: 1440, height: 1000, mobile: false, deviceScaleFactor: 1 },
  phone: { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 },
}

export function chrome () {
  if (process.env.CHROME) return process.env.CHROME
  const base = join(homedir(), '.cache/ms-playwright')
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort() : []
  if (dirs.length) return join(base, dirs[dirs.length - 1], 'chrome-linux64/chrome')
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (existsSync(p)) return p
  throw new Error('no Chromium: set CHROME')
}

// A fresh shallow clone of a ConcatenaLabs repository's default branch, under the cache.
export function clone (cache, repo) {
  const dir = join(cache, repo)
  rmSync(dir, { recursive: true, force: true })
  execFileSync('git', ['clone', '-q', '--depth', '1', `https://github.com/ConcatenaLabs/${repo}.git`, dir], { stdio: ['ignore', 'ignore', 'inherit'] })
  return { dir, rev: execFileSync('git', ['-C', dir, 'rev-parse', '--short=10', 'HEAD']).toString().trim() }
}

export class Report {
  constructor (out, known = {}) {
    this.out = out; this.known = known; mkdirSync(out, { recursive: true })
    this.log = join(out, 'results.txt')
    this.rows = []
  }

  note (s) { console.log(s); appendFileSync(this.log, s + '\n') }

  record (id, width, status, line, detail, shot) {
    this.rows.push({ id, width, status, line, detail, shot })
    const d = detail === undefined || detail === '' ? '' : ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))
    const k = status === 'FAIL' && this.known[id] ? `\n       known: ${this.known[id]}` : ''
    this.note(`${status.padEnd(4)} ${id.padEnd(14)} ${(width || '-').padEnd(7)} ${line}${d.length > 400 ? d.slice(0, 400) + '…' : d}${shot ? '  [' + shot + ']' : ''}${k}`)
  }

  // Runs one line. `page` (optional) is screenshotted on failure, with the result's `at`
  // (a selector) scrolled into view.
  async line (id, width, line, page, fn) {
    let r
    try { r = await fn() } catch (e) { r = { ok: false, detail: String(e && e.message || e).split('\n')[0] } }
    if (r && r.skip) return this.record(id, width, 'SKIP', line, r.skip)
    let shot
    if (!r.ok && page) {
      // A check may name the control it failed on (`at`): it is brought into view first.
      if (r.at) await page.eval(`(document.querySelector(${JSON.stringify(r.at)})||{scrollIntoView(){}}).scrollIntoView({block:'center'}), true`).catch(() => {})
      shot = `${id}-${width || 'any'}.png`
      try { await page.shot(join(this.out, shot)) } catch { shot = undefined }
    }
    this.record(id, width, r.ok ? 'PASS' : 'FAIL', line, r.detail, shot)
    return r.ok
  }

  skip (id, width, line, why) { this.record(id, width, 'SKIP', line, why) }

  summary () {
    const n = (s) => this.rows.filter((r) => r.status === s).length
    this.note(`\n${n('PASS')} passed, ${n('FAIL')} failed, ${n('SKIP')} skipped. Screenshots and this list: ${this.out}`)
    const failed = this.rows.filter((r) => r.status === 'FAIL')
    const ids = [...new Set(failed.map((r) => r.id))]
    const fresh = ids.filter((i) => !this.known[i])
    if (ids.length) this.note('Failing lines: ' + ids.join(' '))
    if (fresh.length) this.note('Not in known.json (new, or a check to fix): ' + fresh.join(' '))
    for (const i of Object.keys(this.known)) if (i !== '_' && this.rows.some((r) => r.id === i) && !ids.includes(i)) this.note(`${i} passes now: take it out of known.json`)
    return failed.length
  }
}

// Page helpers over the extension's CDP Page (test/leaves/cdp.mjs): what every check needs.
export function helpers (page) {
  const q = JSON.stringify
  return {
    page,
    eval: (e) => page.eval(e),
    waitFor: (e, ms) => page.waitFor(e, ms),
    visible: (sel) => page.eval(`(()=>{const e=document.querySelector(${q(sel)}); return !!e && e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden'})()`),
    text: (sel) => page.eval(`((document.querySelector(${q(sel)})||{}).innerText||'').trim()`),
    click: (sel) => page.click(sel),
    // A click on the visible element whose own text is `label` (a button, a tab).
    clickText: (sel, label) => page.eval(`(()=>{const e=[...document.querySelectorAll(${q(sel)})].find(x=>x.getClientRects().length && x.innerText.trim()===${q(label)}); if(!e) throw new Error('no ${String(label).replace(/'/g, '')}'); e.click(); return true})()`),
    type: (sel, v) => page.eval(`(()=>{const i=document.querySelector(${q(sel)}); if(!i) throw new Error('no ${sel.replace(/'/g, '')}'); i.focus(); i.value=${q(String(v))}; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); return true})()`),
    bodyText: () => page.eval('document.body.innerText'),
    // The page is no wider than the screen: nothing scrolls sideways.
    overflow: () => page.eval('Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth'),
  }
}

export async function setWidth (b, page, w) {
  const m = WIDTHS[w]
  await b.send('Emulation.setDeviceMetricsOverride', { width: m.width, height: m.height, deviceScaleFactor: m.deviceScaleFactor, mobile: m.mobile }, page.sessionId)
  await b.send('Emulation.setTouchEmulationEnabled', { enabled: m.mobile }, page.sessionId).catch(() => {})
}

// The words default mode never shows, read from the deployed web wallet itself
// (USER_MODE_FORBIDDEN_WORDS in user-trade.js), so the list here never drifts from the contract.
export async function forbiddenWords (page) {
  return page.eval(`import('https://sequentiatestnet.com/wallet/user-trade.js').then(m=>[...m.USER_MODE_FORBIDDEN_WORDS])`)
}
export function forbiddenIn (text, words) {
  const t = ' ' + String(text).toLowerCase().replace(/[^a-z0-9-]+/g, ' ') + ' '
  return words.filter((w) => t.includes(' ' + w.toLowerCase() + ' ') || t.includes(' ' + w.toLowerCase() + 's '))
}
