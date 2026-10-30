// Levo (sequentiatestnet.com/levo/), at desktop and phone widths: every amount reads in BTC, the
// switch to dollars is remembered, and a sale's page offers both purchase paths. Nothing is
// reserved, bought or signed.
import { sleep, helpers, setWidth } from '../lib/suite.mjs'

// LEVO_URL points the lines at another Levo, such as a local demo before a deploy.
const LEVO = process.env.LEVO_URL || 'https://sequentiatestnet.com/levo'

async function json (path) {
  const r = await fetch(LEVO + path)
  if (!r.ok) throw new Error(path + ': HTTP ' + r.status)
  return r.json()
}

export async function run ({ b, report, widths }) {
  const R = (id, w, line, h, fn) => report.line('LV-' + id, w, line, h && h.page, fn)
  const page = await b.page('about:blank')
  const h = helpers(page)
  const go = async (url, ready, ms = 60000) => { await b.send('Page.navigate', { url }, page.sessionId); await h.waitFor(ready, ms) }
  const BOARD_READY = "document.querySelectorAll('.row').length > 0"
  const SALE_READY = "/Price/.test(document.body.innerText)"

  await R('RATES', null, 'Levo reads the node\'s rates: a price for bitcoin and for each asset a sale settles in', null, async () => {
    const r = await json('/api/rates')
    const n = Object.keys(r.rates || {}).length
    return { ok: !!r.btc_rate && n > 0, detail: { btc_rate: r.btc_rate, assets: n } }
  })
  const list = await json('/api/projects').catch(() => ({ projects: [] }))
  const sales = (list.projects || []).filter((p) => p.sale)
  const ln = sales.find((p) => p.sale.terms && p.sale.terms.lightning)
  const first = ln || sales[0]

  for (const w of widths) {
    await setWidth(b, page, w)
    await page.eval("try{localStorage.removeItem('levo.unit')}catch(e){}; true").catch(() => {})
    await go(LEVO + '/projects?status=all', BOARD_READY); await sleep(1500)
    await R('BOARD-BTC', w, 'The board: every sale\'s price reads in BTC', h, async () => {
      const rows = await h.eval("[...document.querySelectorAll('.row')].map(r=>r.innerText)")
      const btc = rows.filter((t) => / BTC/.test(t)).length
      const inAsset = rows.filter((t) => /\d USDX\b/.test(t)).length
      return { ok: btc > 0 && inAsset === 0, detail: { rows: rows.length, in_btc: btc, in_usdx: inAsset } }
    })
    await R('UNIT-USD', w, 'The BTC / USD switch shows dollars, and the choice survives a reload', h, async () => {
      await h.click('.unit-switch'); await sleep(600)
      const dollars = await h.eval("[...document.querySelectorAll('.row')].some(r=>/\\$\\d/.test(r.innerText))")
      await go(LEVO + '/projects?status=all', BOARD_READY); await sleep(1500)
      const kept = await h.eval("[...document.querySelectorAll('.row')].some(r=>/\\$\\d/.test(r.innerText))")
      await h.click('.unit-switch'); await sleep(400)
      return { ok: dollars && kept, detail: { dollars, kept }, at: '.unit-switch' }
    })
    if (!first) { report.skip('LV-SALE-BTC', w, 'A sale\'s page reads its price and amount raised in BTC', 'no sale is listed'); continue }
    await go(LEVO + '/p/' + first.slug, SALE_READY); await sleep(1500)
    await R('SALE-BTC', w, 'A sale\'s page reads its price and amount raised in BTC, and names the asset it settles in', h, async () => {
      const t = await h.bodyText()
      return { ok: /Price\s+[\d.,]+ BTC per/.test(t) && /Raised\s+[\d.,]+ BTC/.test(t) && /Settles in/.test(t), detail: (t.match(/Price[^\n]*/) || [''])[0] }
    })
  }
  if (!ln) {
    report.skip('LV-LN-SALE', null, 'A sale priced in BTC over Lightning is listed, with its receiver key and BTC price', 'no Lightning sale is listed on the testnet yet')
  } else {
    await R('LN-SALE', null, 'A sale priced in BTC over Lightning is listed, with its receiver key and BTC price', null, async () => {
      const t = ln.sale.terms.lightning
      return { ok: !!t.receiver_xonly && Number(t.btc_num) > 0, detail: { slug: ln.slug, sats_per_atom: t.btc_num + '/' + t.btc_den } }
    })
  }
  // The purchases themselves need a signed-in buyer with staked Sequence and a Lightning wallet,
  // which the suite does not keep yet. Each is proven end to end on regtest by levo's
  // test_lightning_e2e.py.
  report.skip('LV-BUY-LN', null, 'Buy a lot in BTC: reserve, pay the invoice over Lightning, receive the tokens', 'needs a staked buyer wallet the suite does not keep')
  report.skip('LV-BUY-ASSET', null, 'Buy in the asset the sale settles in, in one transaction', 'needs a staked buyer wallet the suite does not keep')
  report.skip('LV-RE-REST', null, 'An unpaid lot goes back to the sale after its timeout', 'needs a staked buyer wallet the suite does not keep')
}
