// Launch Scalp — pump.fun paper-trading bot for make.fun's
// "Pump.fun Paper Sprint: Any Bot Can Win" bounty.
//
// One program, Node 22, no dependencies: it speaks agent-fun/replay/v2 on stdin/stdout
// through the vendored SDK shim (vendor/makefun-bot.ts) and trades the 6-hour replay on
// net PnL. The strategy (strategy.ts) buys only clean launches in their first seconds,
// banks the crowd pop fast, cuts dumps faster, and is gone within seconds.
//
// Run it: node main.ts

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
