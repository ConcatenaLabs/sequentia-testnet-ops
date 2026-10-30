#!/usr/bin/env node
// The regression suite: every capability in CAPABILITIES.md, checked on the live testnet.
//
//   node regression/run.mjs [--only web-wallet,seqdex,ambra-browser,ambra-mobile,trades]
//                           [--widths desktop,phone] [--funded <phrase file>]
//                           [--trader <phrase file>] [--out <dir>]
//
// One line per capability and width: PASS, FAIL (with a screenshot) or SKIP (with why). Exit 0
// only when nothing failed. One headless Chromium at a time, in a fresh profile under the cache;
// the extension and Ambra mobile are fresh shallow clones of their default branches. The funded
// test wallet (--funded, default ~/.local/share/sequentia-regression/wallets/rgfunded.phrase when
// present) is only opened: nothing is sent, traded or signed from it. The trades surface alone
// trades, small amounts and each bounded in time, from the trader wallet (--trader, default
// ~/.local/share/sequentia-regression/wallets/rgtrader.phrase when present; every trade line is
// SKIP without it).
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Report, chrome, clone } from './lib/suite.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1] }
const SURFACES = ['web-wallet', 'seqdex', 'ambra-browser', 'ambra-mobile', 'trades']
const only = flag('--only', SURFACES.join(',')).split(',')
const widths = flag('--widths', 'desktop,phone').split(',')
const fundedFile = flag('--funded', join(homedir(), '.local/share/sequentia-regression/wallets/rgfunded.phrase'))
const funded = existsSync(fundedFile) ? { phrase: readFileSync(fundedFile, 'utf8').trim() } : null
const traderFile = flag('--trader', join(homedir(), '.local/share/sequentia-regression/wallets/rgtrader.phrase'))
const trader = existsSync(traderFile) ? { phrase: readFileSync(traderFile, 'utf8').trim() } : null
const cache = join(homedir(), '.cache/sequentia-regression')
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const out = resolve(flag('--out', join(cache, 'runs', stamp)))
mkdirSync(cache, { recursive: true })
const report = new Report(out, JSON.parse(readFileSync(join(here, 'known.json'), 'utf8')))

const CHROME = chrome()
// Ambra browser from a fresh clone of its default branch, or from a checkout named with --ext (a
// branch's work, before it merges).
const extDir = flag('--ext', null)
const ext = extDir ? { dir: resolve(extDir), rev: execFileSync('git', ['-C', resolve(extDir), 'rev-parse', '--short=10', 'HEAD']).toString().trim() + ' (local checkout)' } : clone(cache, 'sequentia-extension')
const { Browser } = await import(join(ext.dir, 'test/leaves/cdp.mjs'))
report.note(`Live testnet, ${new Date().toISOString()}; widths ${widths.join(', ')}; funded test wallet: ${funded ? 'yes' : 'no'}; trader wallet: ${trader ? 'yes' : 'no'}`)
report.note(`Ambra browser ${ext.rev}; browser ${CHROME}\n`)

// One browser per surface, closed before the next opens. Every page's uncaught exceptions and
// console errors are collected; problems(page) reads them.
async function withBrowser (label, fn) {
  const profile = join(cache, 'profile-' + label)
  rmSync(profile, { recursive: true, force: true })
  // Chromium will not run as root with its sandbox: on the box, where the suite runs as root to be
  // near the services it checks, a headless browser that opens only this testnet's own pages runs
  // without it. Anywhere else nothing changes.
  const root = typeof process.getuid === 'function' && process.getuid() === 0
  const b = new Browser({ chrome: CHROME, profile, ext: ext.dir, consoleLog: join(out, `console-${label}.log`), headless: true,
    extraArgs: ['--window-size=1440,1000', ...(root ? ['--no-sandbox'] : [])] })
  await b.launch(label)
  const seen = new Map()
  b.on((m) => {
    if (!m.sessionId) return
    const q = m.params || {}
    const add = (s) => { if (!seen.has(m.sessionId)) seen.set(m.sessionId, []); seen.get(m.sessionId).push(s) }
    if (m.method === 'Runtime.exceptionThrown') add('exception: ' + ((q.exceptionDetails.exception && q.exceptionDetails.exception.description) || q.exceptionDetails.text).split('\n')[0])
    if (m.method === 'Runtime.consoleAPICalled' && q.type === 'error') add('console.error: ' + q.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
  })
  const problems = (page) => seen.get(page.sessionId) || []
  try { await fn(b, problems) } catch (e) { report.record(label.toUpperCase(), null, 'FAIL', 'the surface\'s checks ran to the end', String(e && e.stack || e).split('\n').slice(0, 2).join(' ')) }
  finally { await b.close().catch(() => {}); rmSync(profile, { recursive: true, force: true }) }
}

for (const s of SURFACES.filter((x) => only.includes(x))) {
  report.note(`=== ${s}`)
  const mod = await import(join(here, 'checks', s + '.mjs'))
  if (s === 'ambra-mobile') { await mod.run({ report, cache }); continue }
  await withBrowser(s, (b, problems) => mod.run({ b, report, widths, funded, trader, problems, ext }))
}
process.exit(report.summary() ? 1 : 0)
