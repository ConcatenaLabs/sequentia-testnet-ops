// A web wallet made before default mode held its coins in the Ark keeps balances in its own hosted
// Lightning channels; in default mode it moves them by itself (the web wallet's
// lightning-to-ark.js): BTC to its own Bitcoin ark, each asset into the operator's tree, the figure
// held, "Moving <amount> <TICKER> so it can be sent in seconds." under it while it moves, and each
// emptied channel closed when that is cheap and safe, or developer mode saying why it stays.
//
// The wallet is one kept for it (--lnmove, default
// ~/.local/share/sequentia-regression/wallets/rglnmove.phrase), restored into a fresh profile. Its
// channels are emptied by the first run that passes, so a later run finds nothing to move and
// says so (SKIP); to run the scenario again, open the wallet in developer mode and Move to
// Lightning some BTC and an asset. The static line (the words and the module) runs without it.
import { sleep, helpers } from '../lib/suite.mjs'

const WALLET = 'https://sequentiatestnet.com/wallet/'
// How long the moves may take: an asset's leaf is the wallet's at the operator's next round.
export const MOVE_MS = 30 * 60000
const SAMPLE_MS = 10000
const MOVING = /^Moving ([\d,.]+) (\S+) so it can be sent in seconds\.$/

async function open (b, h, phrase) {
  await b.send('Page.navigate', { url: WALLET }, h.page.sessionId)
  await h.waitFor("(()=>{const v=(id)=>{const e=document.getElementById(id); return e && getComputedStyle(e).display!=='none'}; return v('app')||v('welcome')})()", 240000)
  await h.eval(`localStorage.setItem('swk.sequentia.mnemonic', ${JSON.stringify(phrase)}), true`)
  await b.send('Page.navigate', { url: 'about:blank' }, h.page.sessionId); await sleep(1500)
  await b.send('Page.navigate', { url: WALLET }, h.page.sessionId)
  await h.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 240000)
}
async function mode (h, m) {
  await h.click('[data-tab=settings]'); await sleep(1500)
  await h.eval(`(()=>{const c=document.querySelector('#mode${m === 'user' ? 'User' : 'Developer'}'); c.checked=true; c.dispatchEvent(new Event('change')); return true})()`)
  await sleep(3000)
  await h.click('[data-tab=balance]'); await sleep(1500)
}
// Each row's ticker, figure, the lines under it, and in developer mode its Lightning part.
const ROWS = `[...document.querySelectorAll('#assetList .bt-row')].map(r=>{const tk=r.querySelector('.bt-tk .tk'); if(!tk) return null;
  const fig=(r.querySelector('.bt-amt b')||{}).innerText||''; const lines=[...r.querySelectorAll('.bt-moving,.bt-arriving')].map(e=>e.innerText.trim());
  const ln=[...r.querySelectorAll('.bt-blk')].map(b=>b.innerText).find(t=>/^Lightning/.test(t))||'';
  return {tk:tk.innerText.trim(), fig:fig.replace(/,/g,''), lines, ln:(ln.match(/^Lightning\\s*([\\d,.]+)/)||[])[1]||null, stays:(ln.match(/stays open: [^\\n]*/g)||[])}}).filter(Boolean)`
// Opens every row's details (developer mode's split lives there).
const OPEN_ALL = "[...document.querySelectorAll('#assetList .tappable')].forEach(r=>{ if(/details/.test(r.innerText) && !/hide details/.test(r.innerText)) r.click() }), true"

export async function run ({ b, report, lnmove }) {
  const R = (id, line, h, fn) => report.line('WW-' + id, null, line, h && h.page, fn)
  const page = await b.page('about:blank')
  const h = helpers(page)

  // The page carries the move and the contract's sentence (no wallet needed).
  await b.send('Page.navigate', { url: WALLET }, page.sessionId); await sleep(3000)
  await R('LNARK-WORDS', 'The page moves a wallet\'s own Lightning balances, saying "Moving <amount> <TICKER> so it can be sent in seconds."', h, async () => {
    const r = await h.eval("(async()=>{const m=await import('./lightning-to-ark.js'); const d=await import('./default-arca.js'); return {mount: typeof m.mountLightningToArk, words: d.DEFAULT_WORDS.moving && d.DEFAULT_WORDS.moving('0.5','USDX')}})()")
    return { ok: r.mount === 'function' && r.words === 'Moving 0.5 USDX so it can be sent in seconds.', detail: r }
  })

  if (!lnmove) { report.skip('WW-LNARK-MOVE', null, 'A wallet from before moves its Lightning balances to the Ark by itself', 'no --lnmove wallet'); return }
  await open(b, h, lnmove.phrase)
  await mode(h, 'developer')
  await sleep(60000)   // the Lightning service's answer, and the nodes reconnected
  await h.eval(OPEN_ALL); await sleep(1500)
  const before = await h.eval(ROWS)
  const inChannels = before.filter((r) => r.ln && Number(r.ln) > 0)
  if (!inChannels.length) { report.skip('WW-LNARK-MOVE', null, 'A wallet from before moves its Lightning balances to the Ark by itself', 'nothing in its channels to move: Move to Lightning in developer mode to run it again'); return }

  await mode(h, 'user')
  const t0 = Date.now()
  const start = new Map((await h.eval(ROWS)).map((r) => [r.tk, Number(r.fig)]))
  const low = new Map(start), saw = new Map(), wrong = []
  for (;;) {
    const rows = await h.eval(ROWS).catch(() => [])
    for (const r of rows) {
      if (low.has(r.tk) && Number(r.fig) < low.get(r.tk)) low.set(r.tk, Number(r.fig))
      for (const l of r.lines) {
        const m = l.match(MOVING)
        if (m) { if (!saw.has(r.tk)) saw.set(r.tk, Math.round((Date.now() - t0) / 1000)) } else if (/^Moving/.test(l)) wrong.push(l)
      }
    }
    const moving = rows.some((r) => r.lines.some((l) => MOVING.test(l)))
    if ((saw.size >= inChannels.length && !moving) || Date.now() - t0 > MOVE_MS) break
    await sleep(SAMPLE_MS)
  }
  const tookS = Math.round((Date.now() - t0) / 1000)
  await mode(h, 'developer'); await sleep(30000)
  await h.eval(OPEN_ALL); await sleep(1500)
  const after = await h.eval(ROWS)
  await R('LNARK-MOVE', 'A wallet from before moves its Lightning balances to the Ark by itself, the figure held, "Moving …" while it moves', h, async () => {
    const detail = {}
    let ok = !wrong.length
    for (const r of inChannels) {
      const a = after.find((x) => x.tk === r.tk) || {}
      // Held: never below the start by more than the move's fees (1% and a little).
      const held = low.get(r.tk) >= start.get(r.tk) * 0.985
      const said = saw.has(r.tk)
      const left = a.ln == null ? 0 : Number(a.ln)
      const emptied = left <= Number(r.ln) * 0.03
      detail[r.tk] = { lightningBefore: r.ln, lightningAfter: a.ln, figureStart: start.get(r.tk), figureLowest: low.get(r.tk), movingSaidAtS: saw.get(r.tk) ?? null, held, emptied, stays: a.stays }
      ok = ok && held && said && emptied
    }
    return { ok, detail: { ...detail, tookS, wrongLines: wrong.slice(0, 3) } }
  })
  await R('LNARK-CLOSED', 'Each emptied channel is closed, or developer mode says why it stays', h, async () => {
    const detail = {}
    let ok = true
    for (const r of inChannels) {
      const a = after.find((x) => x.tk === r.tk) || {}
      const closed = a.ln == null || Number(a.ln) === 0
      detail[r.tk] = closed ? 'closed' : (a.stays.length ? a.stays : 'still open, with no reason given')
      ok = ok && (closed || a.stays.length > 0)
    }
    return { ok, detail }
  })
}
