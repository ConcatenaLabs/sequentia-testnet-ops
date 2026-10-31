# The regression suite

Checks, after every deploy, that each thing a person can do on the testnet's user-facing surfaces
still works: the web wallet in default and developer mode, SeqDEX, Ambra browser, and Ambra mobile
from its source, that trading itself works, and that the public pages around the web wallet (the
front page, the faucet page, Compages, the explorer, the staking pools, the Core download and
Emissio's report scopes) meet a new tester as they should. [`CAPABILITIES.md`](CAPABILITIES.md) lists every line and the rule it holds a
surface to; the rules of default mode are in the web wallet's
[`docs/DEFAULT_MODE.md`](https://github.com/ConcatenaLabs/sequentia-web-wallet/blob/main/docs/DEFAULT_MODE.md).

It runs from a laptop against `https://sequentiatestnet.com`, in headless Chromium, one browser at
a time. Every surface but one sends, trades and signs nothing: its checks open pickers, type
amounts, ask for a review and stop there. The trades surface makes small live trades from a wallet
kept for it (below), each bounded in time.

## Run it

    node regression/run.mjs

About 25 minutes. It needs Node 22 and a Chromium: Playwright's under `~/.cache/ms-playwright`,
`/usr/bin/chromium`, or the one `CHROME` names. Run as root (on the box, near the services it
checks, which takes a slow or far link out of the timings), the browser runs without Chromium's
sandbox, which refuses root. Options:

- `--only web-wallet,seqdex,ambra-browser,ambra-mobile,trades,levo,public-pages`: some surfaces only.
- `SITE_URL=<url>` (environment): the public-pages lines against another front door, such as a
  local build of the pages before a deploy.
- `--widths desktop,phone`: desktop is 1440 px, phone 390 px on a touch screen.
- `--funded <file>`: the funded test wallet's phrase (default
  `~/.local/share/sequentia-regression/wallets/rgfunded.phrase`). Without it, the lines that need
  held assets are SKIP.
- `--trader <file>`: the trader wallet's phrase (default
  `~/.local/share/sequentia-regression/wallets/rgtrader.phrase`). Without it, the trade lines are
  SKIP.
- `--out <dir>`: where the results go (default `~/.cache/sequentia-regression/runs/<time>`).
- `--ext <dir>`: Ambra browser from this checkout instead of a fresh clone of its default branch,
  to run its lines against a branch before it merges.

It prints one line per capability and width, `PASS`, `FAIL` or `SKIP`, with what it saw, and
writes each failure's screenshot beside `results.txt`. It exits 0 only when nothing failed. A
failing line listed in [`known.json`](known.json) prints what lost it, or that it was never
built, and who is on it; it still fails the run. The summary names any failing line that is not
in `known.json` (something new broke, or a check needs fixing) and any listed line that passes
now (take it out).

## The funded test wallet

Some lines need a wallet that holds assets: BTC first and held assets before the rest in a picker,
hiding an asset, paying from what the balance shows. That wallet is made once with the web
wallet's own drive, which opens a new wallet on the live page and asks the faucet to pay it:

    cd sequentia-web-wallet
    node tooling/default-mode-live-drive.mjs ~/.local/share/sequentia-regression/wallets \
      new rgfunded USDX --base https://sequentiatestnet.com/wallet/
    node tooling/default-mode-live-drive.mjs ~/.local/share/sequentia-regression/wallets \
      faucet rgfunded GOLD --base https://sequentiatestnet.com/wallet/

Its phrase stays on the laptop, mode 600, and is never committed. The suite only opens it.

## The trader wallet

The trades surface buys and sells from one web wallet: on USDX / GOLD, tSEQ / USDX and BTC / USDX,
a small market purchase then the sale of what it bought, first in the web wallet's Trade tab, then
on SeqDEX's market page through the same wallet open in another tab. Each must be done within 60
seconds of the confirmation (the Trade tab saying what was bought is received, SeqDEX saying it
traded), or the line fails with what the page says then: a refusal, a trade still waiting, or no
answer. Each line also records how long the person waited for a price, from Review to the ticket
(on SeqDEX, from the button to the wallet's dialog), and fails when that was over 10 seconds. The Trade tab's sale of BTC, paid from the Bitcoin ark, is also followed
to "Settled" with the wallet left open, for up to an hour after it was received
(`WW-TRADE-BTC-ARK-SETTLED`), which makes the surface take up to an hour longer. One run spends about 60 USDX through the books, most of it bought back, plus fees.

The wallet holds USDX in its default mode; the rest it buys. Make it as the funded wallet is made,
under the name `rgtrader`, and top it up with USDX from its Receive tab's faucet or from
`treasury2026`. Its phrase stays on the laptop, mode 600, and is never committed.

## What each part does

| Path | What |
|---|---|
| `run.mjs` | The one command: clones Ambra browser's and Ambra mobile's default branches into the cache, opens one browser per surface, prints the lines and the summary. |
| `lib/suite.mjs` | Lines, results and screenshots; the widths; the page helpers; the words default mode never says, read from the deployed web wallet's `USER_MODE_FORBIDDEN_WORDS`. |
| `checks/web-wallet.mjs` | The web wallet, a fresh wallet and the funded one, default and developer mode. |
| `checks/seqdex.mjs` | SeqDEX's Markets, a pair's page, Portfolio, the wallet chooser, and Ambra browser connected once across pages. |
| `checks/levo.mjs` | Levo's board and a sale's page: amounts in BTC, the switch to dollars, a sale paid over Lightning. Nothing is bought. `LEVO_URL` points it at another Levo, such as a local demo. |
| `checks/ambra-browser.mjs` | Ambra browser's popup in default mode, a fresh wallet and the funded one imported. |
| `checks/trades.mjs` | Live market purchases and sales from the trader wallet, in the Trade tab and on SeqDEX through the web wallet. |
| `checks/ambra-mobile.mjs` | Ambra mobile's source: what each default-mode screen is built from. |
| `known.json` | Lines known to fail, with their cause and owner. |
| `CAPABILITIES.md` | Every line, the rule it holds to, and what is not checked yet. |

The browser is driven through the CDP client of Ambra browser's own drives
(`test/leaves/cdp.mjs` in sequentia-extension), from the clone the run makes.

## Adding a line

A capability that ships gets its line in the same sitting: a row in `CAPABILITIES.md`, and a
check in the surface's file under `checks/`, with the same id. A check reads what a person sees
(text, a control's state) and returns `{ ok, detail }`; `{ skip: why }` only when the line cannot
run here. A capability removed on purpose takes its line and its row out in the pull request that
removes it, which says so.
