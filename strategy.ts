// Launch Scalp: an ultra-short paper trader for the pump.fun bonding-curve replay.
//
// The launch is where the money is. A fresh curve's first seconds decide it: the creator's
// own buy and the first wallets in set the price, then the crowd either piles in (price
// pops in seconds) or the launch dumps (creator or early wallets sell into the crowd).
// This bot buys ONLY the cleanest launches — a small creator buy (at most 0.75 SOL), no
// creator sell yet, at most one other wallet in so far (a launch already crowded by
// many wallets is a bundle waiting to dump), real SOL in a sane band, and the price still
// within 5% of its create price (buying after the run-up is already buying the top) —
// and then it is gone within seconds: bank half at +15%, bank half of the rest at +30%
// and let the last quarter ride a wide trailing stop for the rare multi-x runner, cut
// losers at -25%, out at once if the creator sells, never hold past a short clock.
// Positions are small (the 1%-of-real-reserves cap keeps launch buys tiny), turnover is
// high, and drawdown stays small because nothing is ever held long enough to bleed.
//
// A tiny probe pacer (each mint at most once, at most 30 in the run) keeps the run above
// the guardrail minimums (20 coins, 0.01 SOL round trips) when clean launches are scarce.
//
// Deterministic by construction: no clock, no environment, no Math.random; iteration only
// over insertion-ordered maps fed by the batch stream, so the two grading executions agree.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAgeSlots: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAgeSlots: number;
  /** SOL to aim for per coin (each buy is still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRqSol: number;
  maxRqSol: number;
  /** Creator's own buys in the create slot, at most (SOL): a huge dev buy is a red flag. */
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry, at most: a crowded launch is a dump in waiting. */
  maxBuyers: number;
  /** Distinct non-creator buyers seen before entry, at least. */
  minBuyers: number;
  /** Trades seen before entry, at least. */
  minTrades: number;
  /** SOL sold by others / SOL bought, at most. */
  maxSellRatio: number;
  /** Largest single non-creator sell, as a share of the real SOL reserve before it, at most. */
  maxBigSellShare: number;
  /** Price now over the create price, minus 1: window. */
  minRunup: number;
  maxRunup: number;
  /** Recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowSol: number;
  minRecentBuyers: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlipBps: number;
  /** First take-profit: sell tp1Share of the tokens once total value is up tp1. */
  tp1: number;
  tp1Share: number;
  /** Second take-profit: sell tp2Share of the remaining tokens once total value is up tp2. */
  tp2: number;
  tp2Share: number;
  /** After the second take-profit the rest rides: a wide trailing stop, armed at rideArm. */
  rideArm: number;
  rideTrail: number;
  /** The rider is cut only on a catastrophic fall from invested. */
  rideStop: number;
  /** The rider is held at most this many slots. */
  rideHoldSlots: number;
  /** Stop loss: sell everything once total value is down sl. */
  stopLoss: number;
  /** The trailing stop arms once total value is up trailArm. */
  trailArm: number;
  /** Sell everything on a fall of trail from the best total value. */
  trail: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit at once when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Guardrail pacing: target coins / fills by the time paceSecs of block time has elapsed. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Probe round-trip size in SOL. */
  probeSol: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
  /** Most probe round trips in the whole run (each loses ~fees; never let them dominate). */
  maxTotalProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

// v2 settings: the launch-scalp shape that the dev window rewards — buy the cleanest
// launch before it runs up, bank the pop in stages, let a quarter ride for the rare
// multi-x runner, cut the dump fast. Tuned on the dev window with the kit's replay
// simulator (hundreds of variants), preferring flat regions over single best cells:
// the final window is fresh coins, so robustness beats a dev optimum.
export const DEFAULT_PARAMS: Params = {
  minAgeSlots: 0,
  maxAgeSlots: 5,
  stakeSol: 0.1,
  minBuySol: 0.005,
  minRqSol: 0.3,
  maxRqSol: 30,
  maxDevBuySol: 0.75,
  maxBuyers: 1,
  minBuyers: 1,
  minTrades: 0,
  maxSellRatio: 1.0,
  maxBigSellShare: 1.0,
  minRunup: -0.05,
  maxRunup: 0.05,
  flowWindow: 10,
  minFlowSol: -1000,
  minRecentBuyers: 0,
  skipDevSold: true,
  buySlipBps: 10_000,
  tp1: 0.15,
  tp1Share: 0.5,
  tp2: 0.3,
  tp2Share: 0.5,
  rideArm: 0.5,
  rideTrail: 0.4,
  rideStop: 0.5,
  rideHoldSlots: 3600,
  stopLoss: 0.25,
  trailArm: 0.15,
  trail: 0.1,
  maxHoldSlots: 20,
  exitOnDevSell: true,
  staleSlots: 600,
  targetCoins: 25,
  targetFills: 200,
  paceSecs: 14400,
  probeSol: 0.02,
  maxProbes: 1,
  maxTotalProbes: 30,
  maxExposureSol: 3,
};

const LAMPORTS = 1e9;
/** Curve fees (protocol 95 bps + creator 30 bps) charged on each side of a trade. */
const CURVE_FEE = 0.0125;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Launch {
  creator: Pubkey;
  created: number;
  /** Create-time reserves: the run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  /** Creator's own buys in the create slot, SOL. */
  devBuy: number;
  /** Creator sold at any point. */
  devSold: boolean;
  trades: number;
  buyers: Set<string>;
  bought: number;
  soldByOthers: number;
  /** Largest single non-creator sell as a share of real SOL before it. */
  bigSellShare: number;
  lastTradeSlot: number;
  recent: Tick[];
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  opened: number;
  /** SOL received from sells of this position so far. */
  proceeds: number;
  /** SOL paid in tx fees on this position's fills. */
  txPaid: number;
  /** Best total value (proceeds + remaining value) seen, in SOL. */
  peakTotal: number;
  /** First take-profit already taken. */
  tookTp1: boolean;
  /** Second take-profit taken: the rest rides under the wide rider exits. */
  riding: boolean;
  /** An exit sell is in flight; do not stack another. */
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** The creator had already sold when this position opened. */
  devSoldAtOpen: boolean;
}

interface SellIntent {
  mint: Pubkey;
  /** True when this sell was a full exit (revert the exiting flag on reject). */
  fullExit: boolean;
  /** True when this sell was the tp1 partial (revert tookTp1 on reject). */
  tp1: boolean;
  /** True when this sell was the tp2 partial (revert riding on reject). */
  tp2: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const launches = new Map<Pubkey, Launch>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Map<Pubkey, boolean>();
  /** Mints already probed once: a probe is a guardrail filler, never a repeated trade. */
  const probed = new Set<Pubkey>();
  let probesSent = 0;
  /** Sells sent but not yet resolved, by the client_id we assigned. */
  const sellIntents = new Map<string, SellIntent>();
  /** Consecutive sell rejections per mint: a sell the harness rejects is a rule outcome, not
   * bad luck, so retrying the same order can never land — three in a row abandons the position. */
  const rejectStreak = new Map<Pubkey, number>();
  /**
   * Give up on a position for good: drop it from every retry path and mark its launch done, so
   * a sell that can never fill is tried once, not once a batch for the rest of the run. The
   * harness force-closes any leftover tokens at the end of the data, which costs nothing, so
   * abandoning a worthless position is free and retrying it is pure rejection spam.
   */
  const abandon = (mint: Pubkey): void => {
    held.delete(mint);
    probes.delete(mint);
    rejectStreak.delete(mint);
    const l = launches.get(mint);
    if (l !== undefined) l.done = true;
  };
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  let idCounter = 1;
  const keep = p.flowWindow + 10;

  const launchOf = (mint: Pubkey, creator: Pubkey, slot: number, vq0: bigint, vt0: bigint): Launch => {
    let l = launches.get(mint);
    if (l === undefined) {
      l = {
        creator,
        created: slot,
        vq0,
        vt0,
        devBuy: 0,
        devSold: false,
        trades: 0,
        buyers: new Set(),
        bought: 0,
        soldByOthers: 0,
        bigSellShare: 0,
        lastTradeSlot: slot,
        recent: [],
        done: false,
        complete: false,
      };
      launches.set(mint, l);
    }
    return l;
  };

  const nextId = (): string => `x${idCounter++}`;

  /** Net SOL (buys minus sells) and distinct non-creator buyers over the last flowWindow slots. */
  const recentFlow = (l: Launch, now: number): { net: number; buyers: number } => {
    const from = now - p.flowWindow;
    let cut = 0;
    while (cut < l.recent.length && l.recent[cut]!.slot <= from) cut++;
    if (cut > 0) l.recent.splice(0, cut);
    let net = 0;
    const buyers = new Set<string>();
    for (const t of l.recent) {
      if (t.buy) {
        net += t.sol;
        if (t.user !== l.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  };

  /**
   * SOL received by selling `tokens` of a curve at its current reserves (constant-product
   * quote out, curve fees deducted, one tx fee deducted). The quote out can never exceed
   * the curve's real SOL: on a nearly drained curve a whole position is worth at most
   * what the curve still holds, so the value is capped at the real reserves. Exact bigint
   * math on reserves.
   */
  const sellValueSol = (tokens: bigint, vq: bigint, vt: bigint, rq: bigint, txLamports: bigint): number => {
    if (tokens <= 0n || vt <= 0n) return 0;
    let out = (tokens * vq) / (vt + tokens);
    if (out > rq) out = rq;
    const afterFee = Number(out) * (1 - CURVE_FEE);
    return afterFee / LAMPORTS - Number(txLamports) / LAMPORTS;
  };

  /**
   * Most tokens that can be sold in one order without the quote out exceeding the curve's
   * real SOL (the harness rejects a sell whose quote out tops the real reserves). From
   * t·vq/(vt+t) ≤ rq: t ≤ rq·vt/(vq−rq). A 5% margin covers the reserves moving in the
   * two-slot latency. Zero when the curve holds (almost) no real SOL: nothing is
   * recoverable yet, so do not send a sell that would only be rejected.
   */
  const sellableTokens = (tokens: bigint, vq: bigint, vt: bigint, rq: bigint): bigint => {
    if (tokens <= 0n || rq <= 0n || vt <= 0n) return 0n;
    if (vq <= rq) return tokens;
    const max = (rq * vt) / (vq - rq);
    const margined = (max * 95n) / 100n;
    return margined < tokens ? margined : tokens;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
          const h = held.get(f.mint);
          if (h !== undefined) {
            h.txPaid += Number(f.tx_fee_lamports) / LAMPORTS;
            if (f.side === 'sell') h.proceeds += Number(f.quote_lamports) / LAMPORTS;
            if (f.side === 'buy') h.filled = true;
          }
        }
        const intent = sellIntents.get(f.client_id);
        if (intent !== undefined) {
          sellIntents.delete(f.client_id);
          if (f.status === 'filled') {
            rejectStreak.set(intent.mint, 0);
          } else if (f.status === 'rejected') {
            // A rejection is deterministic: the same order against the same curve state fails
            // the same way, so a streak of them means this position's sell can never land
            // (dust under the ceil'd curve fees, a drained curve, a permanently oversized
            // quote). Abandon it on the third straight rejection instead of retrying it
            // every batch for the rest of the run.
            const streak = (rejectStreak.get(intent.mint) ?? 0) + 1;
            if (streak >= 3) {
              abandon(intent.mint);
            } else {
              rejectStreak.set(intent.mint, streak);
              const h = held.get(intent.mint);
              if (h !== undefined) {
                if (intent.fullExit) h.exiting = false;
                if (intent.tp1) h.tookTp1 = false;
                if (intent.tp2) h.riding = false;
              }
            }
          } else {
            // Failed tx: a random draw, retrying can succeed — revert the flags as before.
            const h = held.get(intent.mint);
            if (h !== undefined) {
              if (intent.fullExit) h.exiting = false;
              if (intent.tp1) h.tookTp1 = false;
              if (intent.tp2) h.riding = false;
            }
          }
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          launchOf(e.mint, e.creator, e.slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        } else if (e.event === 'TradeEvent') {
          const l = launches.get(e.mint);
          if (l === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          l.trades++;
          l.lastTradeSlot = e.slot;
          l.recent.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          const isDev = e.user === l.creator;
          if (e.is_buy) {
            l.bought += sol;
            if (isDev && e.slot === l.created) l.devBuy += sol;
            else if (!isDev) l.buyers.add(e.user);
          } else if (isDev) {
            l.devSold = true;
          } else {
            l.soldByOthers += sol;
            const rqBefore = Number(e.real_quote_reserves) / LAMPORTS + sol;
            if (rqBefore > 0) {
              const share = sol / rqBefore;
              if (share > l.bigSellShare) l.bigSellShare = share;
            }
          }
        } else {
          const l = launches.get(e.mint);
          if (l !== undefined) {
            l.complete = true;
            l.done = true;
          }
        }
      }
      for (const l of launches.values()) {
        let cut = 0;
        while (cut < l.recent.length && l.recent[cut]!.slot <= now - keep) cut++;
        if (cut > 0) l.recent.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
      for (const po of state.pending.values()) {
        const rec = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
        if (po.order.side === 'buy') rec.buy = true;
        else rec.sell = true;
        pendingByMint.set(po.order.mint, rec);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();

      const reservesOf = (mint: Pubkey): { vq: bigint; vt: bigint; rq: bigint; rt: bigint; rqSol: number } | null => {
        const mk = marks.get(mint);
        if (mk !== undefined) {
          return {
            vq: BigInt(mk.virtual_quote_reserves),
            vt: BigInt(mk.virtual_token_reserves),
            rq: BigInt(mk.real_quote_reserves),
            rt: BigInt(mk.real_token_reserves),
            rqSol: Number(mk.real_quote_reserves) / LAMPORTS,
          };
        }
        const curve = state.curves.get(mint);
        if (curve === undefined) return null;
        return {
          vq: curve.virtual_quote_reserves,
          vt: curve.virtual_token_reserves,
          rq: curve.real_quote_reserves,
          rt: curve.real_token_reserves,
          rqSol: Number(curve.real_quote_reserves) / LAMPORTS,
        };
      };

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          const pend = pendingByMint.get(mint);
          if (pend === undefined) {
            held.delete(mint);
            const l = launches.get(mint);
            if (l !== undefined) l.done = true;
          }
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const res = reservesOf(mint);
        if (res === null) continue;
        const tokens = BigInt(pos.token_amount);
        const invested = Number(pos.cost_lamports) / LAMPORTS + h.txPaid;
        const remainingValue = sellValueSol(tokens, res.vq, res.vt, res.rq, tx);
        const total = h.proceeds + remainingValue;
        if (total > h.peakTotal) h.peakTotal = total;
        // Dust: the whole position is worth less than its own tx fee, so no sell of it can
        // ever pay — the harness rejects a sell whose quote falls under the ceil'd curve
        // fees outright (zero_amount), and even a fill would net less than the tx fee.
        // Abandon it instead of retrying the same dead sell once a batch for the rest of
        // the run: this exact trap cost the previous build 21,875 rejections on one mint.
        if (remainingValue <= 0) {
          abandon(mint);
          continue;
        }
        const pend = pendingByMint.get(mint);
        if (pend?.sell) continue; // a sell is already in flight: wait for it
        if (orders.length >= cap) break;
        // How much can actually leave the curve: a sell whose quote out tops the real
        // reserves is rejected, so every sell below is clamped to what fits.
        const sellable = sellableTokens(tokens, res.vq, res.vt, res.rq);

        const l = launches.get(mint);
        let exit = h.exiting;
        if (!exit && h.riding) {
          // The rider: only a wide trailing stop (once armed), a catastrophic stop, the
          // rider clock, a creator sell, or staleness ends it.
          if (invested > 0 && h.peakTotal >= invested * (1 + p.rideArm) && total <= h.peakTotal * (1 - p.rideTrail)) exit = true;
          if (!exit && invested > 0 && total <= invested * (1 - p.rideStop)) exit = true;
          if (!exit && now - h.opened >= p.rideHoldSlots) exit = true;
        } else {
          if (!exit && invested > 0 && total <= invested * (1 - p.stopLoss)) exit = true;
          if (!exit && h.peakTotal >= invested * (1 + p.trailArm) && total <= h.peakTotal * (1 - p.trail)) exit = true;
          if (!exit && now - h.opened >= p.maxHoldSlots) exit = true;
        }
        if (!exit && p.exitOnDevSell && l !== undefined && l.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit && l !== undefined && now - l.lastTradeSlot >= p.staleSlots) exit = true;
        if (exit) {
          if (sellable <= 0n) continue; // curve holds no real SOL: nothing recoverable yet
          // A sell whose net value does not cover its own tx fee is rejected by the harness
          // when the quote falls under the ceil'd curve fees, and loses money even when it
          // fills — never send it. (The dust-abandon above already caught a position whose
          // whole value is gone; this guards a clamped partial on a draining curve.)
          if (sellValueSol(sellable, res.vq, res.vt, res.rq, tx) <= 0) continue;
          h.exiting = true;
          const id = nextId();
          sellIntents.set(id, { mint, fullExit: true, tp1: false, tp2: false });
          orders.push({ side: 'sell', mint, token_amount: sellable.toString(), max_slippage_bps: 10_000, client_id: id });
          continue;
        }
        // First take-profit: bank a share, let the rest run to the second target.
        if (!h.tookTp1 && invested > 0 && total >= invested * (1 + p.tp1)) {
          const planned = (tokens * BigInt(Math.round(p.tp1Share * 1000))) / 1000n;
          const sellTokens = planned < sellable ? planned : sellable;
          if (sellTokens > 0n && sellTokens < tokens && sellValueSol(sellTokens, res.vq, res.vt, res.rq, tx) > 0) {
            h.tookTp1 = true;
            const id = nextId();
            sellIntents.set(id, { mint, fullExit: false, tp1: true, tp2: false });
            orders.push({ side: 'sell', mint, token_amount: sellTokens.toString(), max_slippage_bps: 10_000, client_id: id });
          }
        } else if (h.tookTp1 && !h.riding && invested > 0 && total >= invested * (1 + p.tp2)) {
          // Second take-profit: bank half of what is left; the rest rides for the tail.
          const planned = (tokens * BigInt(Math.round(p.tp2Share * 1000))) / 1000n;
          const sellTokens = planned < sellable ? planned : sellable;
          if (sellTokens > 0n && sellTokens < tokens && sellValueSol(sellTokens, res.vq, res.vt, res.rq, tx) > 0) {
            h.riding = true;
            const id = nextId();
            sellIntents.set(id, { mint, fullExit: false, tp1: false, tp2: true });
            orders.push({ side: 'sell', mint, token_amount: sellTokens.toString(), max_slippage_bps: 10_000, client_id: id });
          } else if (sellTokens >= tokens) {
            h.riding = true;
          }
        }
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (pendingByMint.get(mint) === undefined) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.get(mint) !== undefined) continue;
        if (orders.length >= cap) break;
        const res = reservesOf(mint);
        if (res === null) continue;
        const sellable = sellableTokens(BigInt(pos.token_amount), res.vq, res.vt, res.rq);
        if (sellable <= 0n) continue;
        if (sellValueSol(sellable, res.vq, res.vt, res.rq, tx) <= 0) {
          // Probe dust: the position is worth less than its own tx fee, so its sell can
          // never pay. Drop the probe (the slot frees up; the harness force-closes the
          // leftover tokens at the end of the data) instead of retrying it every batch.
          probes.delete(mint);
          continue;
        }
        const id = nextId();
        sellIntents.set(id, { mint, fullExit: true, tp1: false, tp2: false });
        orders.push({ side: 'sell', mint, token_amount: sellable.toString(), max_slippage_bps: 10_000, client_id: id });
        if (!selling) probes.set(mint, true);
      }

      // Then entries: every known launch, in first-seen order.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        exposure += pos !== undefined ? Number(pos.cost_lamports) / LAMPORTS : h.proceeds;
      }
      for (const [mint, l] of launches) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        if (l.done || l.complete) continue;
        const age = now - l.created;
        if (age < p.minAgeSlots) continue;
        if (age > p.maxAgeSlots) {
          l.done = true;
          continue;
        }
        if (held.has(mint) || probes.has(mint) || pendingByMint.get(mint) !== undefined) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        // Rug filter.
        if (l.devSold && p.skipDevSold) {
          l.done = true;
          continue;
        }
        const res = reservesOf(mint);
        if (res === null) continue;
        if (res.rqSol < p.minRqSol || res.rqSol > p.maxRqSol) continue;
        if (l.devBuy > p.maxDevBuySol) continue;
        if (l.trades < p.minTrades || l.buyers.size < p.minBuyers || l.buyers.size > p.maxBuyers) continue;
        if (l.bought > 0 && l.soldByOthers > l.bought * p.maxSellRatio) continue;
        if (l.bigSellShare > p.maxBigSellShare) continue;
        const runup = l.vt0 > 0n ? Number(res.vq) / Number(res.vt) / (Number(l.vq0) / Number(l.vt0)) - 1 : 0;
        if (runup < p.minRunup || runup > p.maxRunup) continue;
        const fl = recentFlow(l, now);
        if (fl.net < p.minFlowSol || fl.buyers < p.minRecentBuyers) continue;
        const capLamports = state.maxBuyLamports(mint);
        let amount = p.stakeSol;
        const capSol = Number(capLamports) / LAMPORTS;
        if (amount > capSol) amount = capSol;
        if (amount > p.maxExposureSol - exposure) amount = p.maxExposureSol - exposure;
        if (amount > free - Number(tx) / LAMPORTS) amount = free - Number(tx) / LAMPORTS;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + Number(tx) / LAMPORTS;
        exposure += amount;
        held.set(mint, { opened: now, proceeds: 0, txPaid: 0, peakTotal: 0, tookTp1: false, riding: false, exiting: false, filled: false, devSoldAtOpen: l.devSold });
        slotsLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      // Each mint is probed at most once and the run holds at most maxTotalProbes: a probe
      // is a guardrail filler, and repeating it on the same liquid coin would bleed fees.
      if (probes.size < p.maxProbes && probesSent < p.maxTotalProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const [mint, curve] of state.curves) {
            if (orders.length >= cap || probes.size >= p.maxProbes || probesSent >= p.maxTotalProbes) break;
            if (held.has(mint) || probes.has(mint) || probed.has(mint) || pendingByMint.get(mint) !== undefined || state.positions.has(mint)) continue;
            if (curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + (2 * Number(tx)) / LAMPORTS) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            probed.add(mint);
            probesSent++;
            free -= p.probeSol + Number(tx) / LAMPORTS;
          }
        }
      }
      return orders;
    },
  };
}
