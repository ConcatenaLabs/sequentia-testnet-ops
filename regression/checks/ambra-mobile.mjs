// Ambra mobile, read from its source (a fresh clone of its default branch): no phone or emulator
// runs here. Each line names the file and what in it carries the capability. A source line says
// the capability is built, not that it works on a phone: those are run on a device, by hand.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { clone } from '../lib/suite.mjs'

export async function run ({ report, cache }) {
  const { dir, rev } = clone(cache, 'ambra')
  report.note(`Ambra mobile ${rev} (source)`)
  const src = (p) => { const f = join(dir, 'app/lib/src', p); return existsSync(f) ? readFileSync(f, 'utf8') : '' }
  const R = (id, line, fn) => report.line('AM-' + id, 'source', line, null, async () => fn())
  const composer = src('screens/user_composer.dart'), send = src('screens/send_screen.dart'), shell = src('screens/shell.dart')
  const picker = src('data/asset_picker.dart'), words = src('data/default_words.dart'), history = src('screens/history_screen.dart')

  await R('TRD-SEARCH', 'Trade (default mode): the pickers are searchable, take a pasted id and leave hidden assets out (showAssetSheet)', () => {
    const plain = /DropdownButton<String>\(/.test(composer); const sheet = /showAssetSheet\(/.test(composer)
    return { ok: sheet && !plain, detail: plain ? 'user_composer.dart: _picker is a plain DropdownButton (ucPay, ucGet)' : { sheet } }
  })
  await R('TRD-AMOUNTS', 'Trade (default mode): an amount in You pay shows what You get, and the other way', () => {
    const n = (composer.match(/TextField\(/g) || []).length; return { ok: n >= 2, detail: `${n} amount field(s) in user_composer.dart` }
  })
  await R('TRD-MARKET', 'Trade (default mode): the pair\'s market (last price, 1D 1W 1M chart, best bid and ask, recent trades)', () => {
    const ok = /'1D'/.test(composer) && /Best bid/.test(composer + src('data/user_trade.dart')); return { ok, detail: ok ? '' : 'no market view in user_composer.dart' }
  })
  await R('SND-PICKER', 'Send: a searchable asset sheet, BTC first, held first, hidden left out, a pasted id found', () => {
    const ok = /showAssetSheet\(/.test(send) && /registrySearch:\s*true/.test(send) && /isHidden\(/.test(send) && /BTC/.test(picker) && /hidden/.test(picker)
    return { ok }
  })
  await R('BAL-HIDE', 'Balance: an asset can be hidden and comes back from "Hidden assets (N)"; BTC cannot be hidden', () => {
    const ok = /_HiddenAssetsSection/.test(shell) && /Hidden assets/.test(shell) && /setHidden/.test(src('data/hidden_assets.dart'))
    return { ok }
  })
  await R('RCV-CODE', 'Receive (default mode): "Receive code", "Copy receive code", "New code", one bitcoin: pay code', () => {
    const ok = /Receive code/.test(words) && /Copy receive code/.test(words) && /New code/.test(words) && /PayCode\(/.test(shell)
    return { ok }
  })
  await R('WORDS-TEST', 'Default mode\'s sentences are tested against the words default mode never says', () => {
    const t = join(dir, 'app/test/default_words_test.dart'); const ok = existsSync(t) && /forbidden/.test(readFileSync(t, 'utf8'))
    return { ok, detail: ok ? 'app/test/default_words_test.dart' : 'no test' }
  })
  await R('HIS-TRADES', 'History: a default-mode trade is one row ("Swapped <pay> for <get>")', () => {
    const ok = /UserTrade|userTrade|Swapped/.test(history); return { ok, detail: ok ? '' : 'history_screen.dart lists chain transactions only; default-mode trades show only under Swap › Your trades' }
  })
}
