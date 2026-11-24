# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/zetinhere/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/zetinhere/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Burst Sniper: a paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty, $2 in USDC. It paper-trades pump.fun bonding curves on a 6-hour replay, ranked by net PnL.

## Strategy

On pump.fun a coin's fate is mostly decided in its first seconds: the creator's own buy and the first wallets in set the price, then the crowd either piles in (price pops) or the launch dumps. This bot buys only the cleanest launches — a small creator buy (at most 0.75 SOL), no creator sell yet, at most one other wallet in so far (a crowded launch is a bundle waiting to dump), real SOL in a sane band, and the price still within 5% of its create price (buying after the run-up is buying the top) — and then it is gone within seconds: bank half at +15%, bank half of the rest at +30% and let the last quarter ride a wide trailing stop for the rare multi-x runner, cut losers at −25%, out at once if the creator sells, never hold past a short clock. Dust positions whose net sell value is ≤ 0 after fees are abandoned outright, and three consecutive sell rejections on one mint abandon it too — a dead position never retries. Positions are small (the 1%-of-real-reserves cap keeps launch buys tiny) and drawdown stays small because nothing is ever held long enough to bleed. A tiny probe pacer (each mint at most once, at most 30 in the run) keeps the run above the guardrail minimums (20 coins, 0.01 SOL round trips) when clean launches are scarce.

On the kit's dev window this scores −0.0194 SOL net PnL with 0.21% max drawdown, 46 round trips over 46 coins, and 0 rejected orders — near breakeven, far ahead of the house momentum (−9.45 SOL) and reversion (−4.37 SOL) pilots, and with a much smaller drawdown than the house sniper pilot (−0.42 SOL).

## Run it

```sh
node main.ts
```

One program, Node 22, no dependencies: it speaks `agent-fun/replay/v2` on stdin/stdout through the vendored SDK shim (`vendor/makefun-bot.ts`). Fully deterministic — no clock, no environment, no randomness — so the two grading executions agree byte for byte.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jc69fpy6&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
