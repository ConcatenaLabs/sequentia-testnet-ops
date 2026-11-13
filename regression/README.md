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

- `--only web-wallet,seqdex,ambra-browser,ambra-mobile,trades,levo,public-pages,ln-to-ark`: some surfaces only.
- `SITE_URL=<url>` (environment): the public-pages lines against another front door, such as a
  local build of the pages before a deploy.
- `--widths desktop,phone`: desktop is 1440 px, phone 390 px on a touch screen.
- `--funded <file>`: the funded test wallet's phrase (default
  `~/.local/share/sequentia-regression/wallets/rgfunded.phrase`). Without it, the lines that need
  held assets are SKIP.
- `--trader <file>`: the trader wallet's phrase (default
  `~/.local/share/sequentia-regression/wallets/rgtrader.phrase`). Without it, the trade lines are
  SKIP.
- `--lnmove <file>`: the phrase of a wallet from before default mode, with balances in its own
  Lightning channels (default `~/.local/share/sequentia-regression/wallets/rglnmove.phrase`).
  Without it, the move's live line is SKIP.
- `--out <dir>`: where the results go (default `~/.cache/sequentia-regression/runs/<time>`).
- `--ext <dir>`: Ambra browser from this checkout instead of a fresh clone of its default branch,
  to run its lines against a branch before it merges.
- `WW_BASE=<url>` (environment): the web wallet's lines read this copy of the page instead of
  the public one, such as a branch served in front of the testnet by the web wallet's
  `tooling/live-proxy.mjs` (`WW_BASE=http://127.0.0.1:8791/wallet/`), before it is deployed.

It prints one line per capability and width, `PASS`, `FAIL` or `SKIP`, with what it saw, and
writes each failure's screenshot beside `results.txt`. It exits 0 only when nothing failed. Its
browser never outlives it: the run kills the browser it started when it ends, whatever ends it (a
signal, a crash, an SSH session closed under it), and a browser an earlier run left on the same
profile is stopped before the profile is used, with a line in the results that says so. A browser
left running would keep the trader wallet open and trading beside the next run's. A
failing line listed in [`known.json`](known.json) prints what lost it, or that it was never
built, and who is on it; it still fails the run. The summary names any failing line that is not
in `known.json` (something new broke, or a check needs fixing) and any listed line that passes
now (take it out).

## The faucet token

The testnet faucet pays each asset once per wallet, and each asset to at most ten wallets a day
from one network.
Our own tooling is never refused: a request that carries the token the box keeps in
`/root/sequentia/faucet-state/exempt.token`, as the header `X-Faucet-Exempt`, is neither
checked nor recorded. The suite reads its copy from `FAUCET_EXEMPT_TOKEN_FILE` alone when that is
set, else from `~/.config/sequentia/faucet-exempt.token` (mode 600, never committed), else, run as
root on the box, from the box's own file, and adds it to the requests the web wallet page and the
faucet page make to `/faucet` and to nothing else (`faucetPass` in `lib/suite.mjs`).
Without it the suite runs as any tester does, and `WW-FAUCET-AT-ONCE` is SKIP once runs from one
network have asked for ten wallets in a day. Copy it from the box once:

    (umask 077; ssh seq 'cat /root/sequentia/faucet-state/exempt.token' > ~/.config/sequentia/faucet-exempt.token)

## The funded test wallet

Some lines need a wallet that holds assets: BTC first and held assets before the rest in a picker,
hiding an asset, paying from what the balance shows. That wallet is made once with the web
wallet's own drive, which opens a new wallet on the live page and asks the faucet to pay it (with
the faucet token, which the drive reads from the same place, as many times as it is needed):

    cd sequentia-web-wallet
    node tooling/default-mode-live-drive.mjs ~/.local/share/sequentia-regression/wallets \
      new rgfunded USDX --base https://sequentiatestnet.com/wallet/
    node tooling/default-mode-live-drive.mjs ~/.local/share/sequentia-regression/wallets \
      faucet rgfunded GOLD --base https://sequentiatestnet.com/wallet/

Its phrase stays on the laptop, mode 600, and is never committed. The suite only opens it.

## The trader wallet

The trades surface opens that wallet in a browser profile kept between runs
(`~/.cache/sequentia-regression/profile-trades-kept`), as a person's own browser keeps it. The
first run, or one started with `--fresh-trader`, restores it from its phrase in a fresh profile.
It holds weeks of trades, so this is the long-history restore, bounded on a line of its own
(`WW-RESTORE-LONG`): the restore must end within 300 seconds. Every later run reopens the wallet
from the kept profile; the line is then SKIP, with how long the wallet took to open. A kept
profile can reopen the last run's tabs, and a wallet page among them holds the wallet's one-tab
lock, so the run closes every tab but its own first and says which it closed. A run trades
only once the leaf wallet is open and its restore has ended, never on a half-restored wallet, and
the run prints how long that took. A wallet not open after 40 minutes skips the trade lines with
that reason. The trade lines then wait until the Trade tab lists every asset the wallet's library
says it can spend now and the wallet has stepped through its restored history (until then it
refuses a trade that would wait on money), 5 minutes at most; after a restore in a fresh profile
the first of those has its own line, `WW-RESTORE-TRADABLE`, which fails past 15 seconds. The kept profile also keeps the wallet's
trade records, so a trade an earlier run left under way is picked up and completed.

### What the trader holds

At the start of the trades surface and at its end, the run prints what the trader holds, one
`trader:` line per asset, as the wallet's own page computes it (`lib/holdings.mjs`; never from the
phrase or a key): what can be traded now (the Trade tab's figure), what is in a round of the
wallet's own, what is on its way, what is held for another party's preimage (never the wallet's to
spend until that preimage comes), what is on the chain, and BTC on each rail (the chain, the
Bitcoin ark with its spendable and arriving parts, and Lightning). Where the page's figure and the
library's differ, both are printed.

`WW-TRADER-FUNDED` says whether the trader holds what the lines need, naming each line's amount:
the lines that pay USDX pay it from the trader's own holdings, every other asset from the purchase
before it. A SeqDEX purchase names what it receives, so its need is that amount at the public
price feed's rate (`/prices`) and 25% over. When the trader is short of an asset the public faucet
gives, the run opens the faucet page, asks it for that asset to the trader's own receive code (from
its Receive tab), as a person would, and waits up to 5 minutes until the wallet shows it and can
trade it; the results say what it asked, what the faucet answered and what arrived. The faucet
pays each asset once per wallet, so a trader that has had its USDX is paid again only with the
faucet token (above). The faucet is the only source: no other wallet pays the trader. BTC is never
topped up: the BTC lines sell the BTC the BTC purchase before them bought.

A line that lacks what it pays is SKIP, not FAIL, and says why: a line paying USDX that the trader
is short of names `WW-TRADER-FUNDED`, which is the line that fails; a sale whose purchase did not
trade says whether the wallet holds none of the asset or holds it where it cannot be spent yet
(in a round of its own, on its way, held for another party's preimage).

The trades surface buys and sells from one web wallet: on USDX / GOLD, tSEQ / USDX and BTC / USDX,
a small market purchase then the sale of what it bought, first in the web wallet's Trade tab, then
on SeqDEX's market page through the same wallet open in another tab. Each must be done within 60
seconds of the confirmation (the Trade tab saying what was bought is received, SeqDEX saying it
traded), or the line fails with what the page says then: a refusal, a trade still waiting, or no
answer. A purchase paid with BTC is done only once the BTC is paid and what it bought is
collected: the wallet's Trade tab row reads "Received" or "Settled", within 180 seconds of the
confirmation, on SeqDEX as well as in the Trade tab. Whatever the site said meanwhile is reported
beside it, never taken for it. When the lines end, the page stays open until every such purchase
is paid and collected, as well as until no refresh waits for a round (15 minutes at most). The
summary says how many were left unpaid or uncollected. A Trade tab trade of two assets in the tree is done once what it brought can be spent:
"Settled". The wallet says "Received, settling" only while a round is still needed first, so such a
line must also read "Settled" within 150 seconds (two rounds) of reading "Received". Each line also records how long the person waited for a price, from Review to the ticket
(on SeqDEX, from the button to the wallet's dialog), and fails when that was over 10 seconds.

A trade paid from coins that first wait for the wallet's own round gets an indicative ticket
instead of a firm one: a price "about", the least it goes for, and the wait in words ("Goes through
within about 6 minutes"). Once confirmed, it goes by itself when the round is through; SeqDEX says
it is under way, and the line follows it in the wallet's Trade tab. Such a line keeps the 10-second
bar for its ticket, and passes when the trade reads "Settled" (for a trade with BTC, "Received")
within the wait its ticket stated. A ticket that waits without naming a time ("Goes through by
itself once what you pay is ready") is held to the suite's longest wait, 12 minutes, and its line
says the ticket named none. A firm trade that SeqDEX answers is under way is followed in the
Trade tab the same way and must end within the 60 seconds of a firm trade. A trade the wallet
accepted that never gets a row in the Trade tab fails saying so: the ticket it was accepted with,
when, how long there has been no row, and what the site showed. It is watched for up to three times that wait, so that it says
when the trade really ended, against the wait stated. Each trade line names its kind of ticket
(firm, or "waited for a round") with both times, and the summary counts the trades of each kind
with their lines, so a run that passes because every trade waited for a round is seen as such. The Trade tab's sale of BTC, paid from the Bitcoin ark, is also followed
to "Settled" with the wallet left open, for up to an hour after it was received
(`WW-TRADE-BTC-ARK-SETTLED`), which makes the surface take up to an hour longer. One run spends about 60 USDX through the books, most of it bought back, plus fees.

When the lines end, the wallet's page stays open until none of its refreshes waits for a round and
no coin of it is on its way, for 15 minutes at most. A last line in the results says how it left:
"nothing waits for a round", or what still waited when the page closed. The operator broadcasts a
round only once every refresh in it has handed over its forfeits, and only an open page can hand
them over. A page closed earlier voids its refreshes ten minutes later, holds back everyone else's
refreshes in those rounds, and leaves the trader's coins unusable at the next run.

The wallet holds USDX in its default mode; the rest it buys. Make it as the funded wallet is made,
under the name `rgtrader`; the run tops up its USDX from the public faucet when it is short
(above). Its phrase stays on the laptop, mode 600, and is never committed.

## The Lightning-to-Ark wallet

The `ln-to-ark` surface opens a web wallet that holds BTC and an asset in its own hosted Lightning
channels, as a wallet made before default mode held its coins in the Ark does, and watches it in
default mode for up to 30 minutes: what the channels hold moves to the wallet's Bitcoin ark and
the operator's tree by itself, the figure holds, "Moving <amount> <TICKER> so it can be sent in
seconds." shows while it moves, and each emptied channel is closed or developer mode says why it
stays. A run that passes empties the channels, so the next one says there is nothing to move
(SKIP). To run it again, open the wallet in developer mode and Move to Lightning some BTC and an
asset (the channel opens after a few testnet4 blocks). Keep the phrase as `rglnmove`, mode 600,
never committed.

## What each part does

| Path | What |
|---|---|
| `run.mjs` | The one command: clones Ambra browser's and Ambra mobile's default branches into the cache, opens one browser per surface, prints the lines and the summary. |
| `lib/suite.mjs` | Lines, results and screenshots; the widths; the page helpers; the words default mode never says, read from the deployed web wallet's `USER_MODE_FORBIDDEN_WORDS`. |
| `lib/holdings.mjs` | What the trader holds, read from its page, in words; what each trade line needs of it; the words for a trade that leaves no row. |
| `checks/web-wallet.mjs` | The web wallet, a fresh wallet and the funded one, default and developer mode. |
| `checks/seqdex.mjs` | SeqDEX's Markets, a pair's page, Portfolio, the wallet chooser, and Ambra browser connected once across pages. |
| `checks/ln-to-ark.mjs` | A wallet from before default mode moving its own Lightning balances to the Ark: the words and the module on the page, then the move live from the `rglnmove` wallet. |
| `checks/levo.mjs` | Levo's board and a sale's page: amounts in BTC, the switch to dollars, a sale paid over Lightning. Nothing is bought. `LEVO_URL` points it at another Levo, such as a local demo. |
| `checks/ambra-browser.mjs` | Ambra browser's popup in default mode, a fresh wallet and the funded one imported. |
| `checks/trades.mjs` | Live market purchases and sales from the trader wallet, in the Trade tab and on SeqDEX through the web wallet; the trader's holdings and its top-up from the faucet page. |
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
