// Every read and write the page makes goes through this file: JSON-RPC to the chain (SqueekCore, SQK, LightsOn),
// Squeekchain's status API (wheel speed only), and the player's wallet (EIP-1193, window.ethereum).
// ABI encoding and decoding is done by hand. The selectors and event topics below were computed with
// `cast sig` / `cast keccak` (Foundry 1.7.1) and checked against contracts/out/LightsOn.sol/LightsOn.json.
// Nothing here keeps page state, so tests can point it at a local anvil RPC and a fake wallet.

export const SEL = {
  // SqueekCore
  state: '0xc19d93fb', // state()
  roundPage: '0xc8b9e08f', // roundPage(uint64,uint64,uint256)
  // SQK (ERC-20)
  balanceOf: '0x70a08231', // balanceOf(address)
  allowance: '0xdd62ed3e', // allowance(address,address)
  approve: '0x095ea7b3', // approve(address,uint256)
  // LightsOn
  bet: '0x7c695384', // bet(uint8,uint256)
  betUntil: '0xffc37000', // betUntil(uint8,uint256,uint256): reverts TooLate if it lands after round lastRound
  claim: '0x6ba4c138', // claim(uint256[])
  poke: '0x32145f90', // poke(uint256)
  settle: '0x8df82800', // settle(uint256)
  openNight: '0x41f8a3a5', // openNight()
  bonusPot: '0x81cd5eec', // bonusPot()
  betCount: '0xcf094497', // betCount()
  nightCount: '0x6000d1fb', // nightCount()
  getBet: '0x061e494f', // getBet(uint256)
  getNight: '0xd0242952', // getNight(uint256)
  getWalker: '0xc95e828e', // getWalker()
  betOutcome: '0x86ed98ae', // betOutcome(uint256)
  lastBet: '0x2c4ef7b5', // lastBet(address)
  nextSettle: '0xfac53f8c', // nextSettle()
  voided: '0xb15856e4', // voided()
  void: '0xac4c25b2', // void(): ends the game (7 days asleep, or 24 h after a stall flag)
  flagStall: '0xfb6a073d', // flagStall()
  asleepTooLong: '0x95217c87', // asleepTooLong()
  stalled: '0x526e3e64', // stalled(): needs 2.1M gas for its read of the core (NeedMoreGas below that)
  stallFlaggedAt: '0xc3044466', // stallFlaggedAt()
  G: '0x6fecb623', // G()
  STATION: '0x711148f8', // STATION()
  MIN_BET: '0x6540742f', // MIN_BET()
  MAX_BET: '0x7e95b523', // MAX_BET()
  CORE: '0x6b6c0774', // CORE()
  SQK: '0xf5c83edd', // SQK()
  START_ROUND: '0x7bd34c3f', // START_ROUND(): the game counts his rounds (and a week asleep) from here
};

export const TOPIC = {
  BetPlaced: '0xbfcd8f4e47cc529f86cdc7eab8fb80e015a298e021fcaee72df1f76dd57cf487', // BetPlaced(uint256,address,uint8,uint256,uint256)
  Claimed: '0x4ec90e965519d92681267467f775ada5bd214aa92c0dc93d90a5e880ce9ed026', // Claimed(uint256,address,uint256)
  Refunded: '0x7ca5472b7ea78c2c0141c5a12ee6d170cf4ce8ed06be3d22c8252ddfc7a6a2c4', // Refunded(uint256,address,uint256), after a void
  Voided: '0x8532e58d991813980022f4053d2c415195cde8ae51cfca6a78dadcf03d61c465', // Voided(): the game ended
  StallCleared: '0xfc5c94bbf3e714e8153baf984ef4006fd8cfaf4943756dfac63ab0833b1d38d9', // StallCleared(): void() found the core fine again
  StallFlagged: '0x28d82cf57f1b89f5598fc3849001c3239da0a60c9b131b310d49c51d1bf6fbaf', // StallFlagged(uint256)
  NightClosed: '0x9ad236d84499a9df7eb833f4ae7b55073fc370f5aae372e5d603f1eb096eb547',
  NightSettled: '0x5620ea0fd075bc62f527c3b811bc61a21a5ec9b250c5ff369e9a5fb464023bbb',
  RoundRecorded: '0x6f7efb5b00900843c192802a77e52da9f18fee1daa04089fc4bf159963c7968c', // roundId is indexed
};

// Revert reasons the page explains. Custom errors by selector; MockSQK (local tests) reverts with plain strings.
export const ERRORS = {
  '0xa820742e': 'AlreadyBet',
  '0x749b5939': 'BadAmount',
  '0x2e96fc6c': 'BadBulb',
  '0xccbb40ce': 'IsVoided',
  '0xa0970340': 'BeforeGenesis',
  '0x90b8ec18': 'TransferFailed',
  '0xed3ba6a6': 'Reentrant',
  '0xecdd1c29': 'TooLate', // betUntil: the bet landed after the round the page showed
  '0x5d3c83b2': 'PokeFirst', // the game hasn't read every round the core has yet: poke, then bet again
  '0xc28d4aae': 'NeedMoreGas',
  '0xeb966ada': 'SettleFirst',
  '0x085de625': 'TooEarly',
  '0xc27d258a': 'NotStalled',
  '0xba329a9b': 'NotSettled',
  '0x383c03c7': 'BadPage',
  '0x1fb83773': 'InvalidRoundPageBounds',
  '0xe450d38c': 'ERC20InsufficientBalance', // (address sender, uint256 balance, uint256 needed)
  '0xfb8f41b2': 'ERC20InsufficientAllowance', // (address spender, uint256 allowance, uint256 needed)
  '0x94280d62': 'ERC20InvalidSpender',
  '0x08c379a0': 'Error', // Error(string)
  '0x4e487b71': 'Panic',
};

// Bet status and class numbers from LightsOn.sol / LightsMath.sol.
export const STATUS = { WAITING: 0, COUNTED: 1, CLAIMED: 2, REFUNDED: 3 };
export const CLS = { REFUND: 0, WIN: 1, LOSE: 2 };
export const RESULT = { SETTLING: 0, PAID: 1, ROLLED: 3 };
// When the game may be ended (LightsOn.sol): SLEEP_ROUNDS without a running round, or a core that hasn't settled for
// STALL_ROUNDS (flagStall), still stuck VOID_DELAY seconds after the flag (void).
export const SLEEP_ROUNDS = 1008, STALL_ROUNDS = 144, VOID_DELAY = 86_400;
const STALL_READ_GAS = 3_000_000; // stalled() reverts NeedMoreGas under 2.1M

export const SEPOLIA_ID = 11155111;
const DEFAULT_STATUS_API = 'https://api.squeekchain.com/v1/status';

// ---------------------------------------------------------------- ABI by hand

const hex64 = (v) => {
  const b = BigInt(v);
  if (b < 0n || b >= 1n << 256n) throw new RangeError(`not a uint256: ${v}`);
  return b.toString(16).padStart(64, '0');
};
export const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const addr64 = (a) => {
  if (!isAddress(a)) throw new TypeError(`not an address: ${a}`);
  return a.slice(2).toLowerCase().padStart(64, '0');
};

export const encode = {
  balanceOf: (owner) => SEL.balanceOf + addr64(owner),
  allowance: (owner, spender) => SEL.allowance + addr64(owner) + addr64(spender),
  approve: (spender, amount) => SEL.approve + addr64(spender) + hex64(amount),
  bet: (bulb, amount) => {
    if (!Number.isInteger(bulb) || bulb < 0 || bulb > 255) throw new RangeError(`bulb ${bulb}`);
    return SEL.bet + hex64(bulb) + hex64(amount);
  },
  betUntil: (bulb, amount, lastRound) => {
    if (!Number.isInteger(bulb) || bulb < 0 || bulb > 255) throw new RangeError(`bulb ${bulb}`);
    return SEL.betUntil + hex64(bulb) + hex64(amount) + hex64(lastRound);
  },
  claim: (ids) => SEL.claim + hex64(32) + hex64(ids.length) + ids.map(hex64).join(''),
  poke: (pages) => SEL.poke + hex64(pages),
  voidGame: () => SEL.void,
  flagStall: () => SEL.flagStall,
  settle: (work) => SEL.settle + hex64(work),
  roundPage: (after, through, max) => SEL.roundPage + hex64(after) + hex64(through) + hex64(max),
  getBet: (id) => SEL.getBet + hex64(id),
  getNight: (id) => SEL.getNight + hex64(id),
  betOutcome: (id) => SEL.betOutcome + hex64(id),
  lastBet: (owner) => SEL.lastBet + addr64(owner),
  topicAddress: (a) => '0x' + addr64(a),
};

// 32-byte words of a return value, as BigInts.
export function words(data) {
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{64})*$/.test(data)) throw new Error(`bad ABI data: ${String(data).slice(0, 80)}`);
  const out = [];
  for (let i = 2; i < data.length; i += 64) out.push(BigInt('0x' + data.slice(i, i + 64)));
  return out;
}
const num = (w) => {
  if (w > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`number too large: ${w}`);
  return Number(w);
};
const toAddr = (w) => '0x' + w.toString(16).padStart(40, '0');
const need = (w, n, what) => { if (w.length < n) throw new Error(`${what}: ${w.length} words, expected ${n}`); return w; };

export const decode = {
  uint: (data) => need(words(data), 1, 'uint')[0],
  bool: (data) => need(words(data), 1, 'bool')[0] !== 0n,
  address: (data) => toAddr(need(words(data), 1, 'address')[0]),
  // state(): (settledThroughRound, cumulativeWork, cumulativeBlockUnits, blockHeight, blockProgress,
  //           workPerThousandBlocks, authorizationNonce, paused)
  state(data) {
    const w = need(words(data), 8, 'state');
    return { settledThrough: num(w[0]), cumulativeWork: w[1], paused: w[7] !== 0n };
  },
  // roundPage: one dynamic struct (certifiedThroughRound, LedgerPosition start, LedgerPosition end, RoundRecord[]).
  // LedgerPosition = 3 words, RoundRecord = 5 words (roundId, cumulativeWork, cumulativeBlockUnits,
  // workPerThousandBlocks, dataHash); every record is an active round.
  roundPage(data) {
    const w = words(data);
    const base = num(need(w, 1, 'roundPage')[0]) / 32;
    need(w, base + 8, 'roundPage');
    const pos = (i) => ({ cumulativeWork: w[i], cumulativeBlockUnits: w[i + 1], workPerThousandBlocks: num(w[i + 2]) });
    const arr = base + num(w[base + 7]) / 32;
    const n = num(need(w, arr + 1, 'roundPage rounds')[arr]);
    need(w, arr + 1 + 5 * n, 'roundPage records');
    const rounds = [];
    for (let i = 0; i < n; i++) {
      const at = arr + 1 + 5 * i;
      rounds.push({ roundId: num(w[at]), cumulativeWork: w[at + 1], cumulativeBlockUnits: w[at + 2], workPerThousandBlocks: num(w[at + 3]), dataHash: '0x' + w[at + 4].toString(16).padStart(64, '0') });
    }
    return { certifiedThrough: num(w[base]), start: pos(base + 1), end: pos(base + 4), rounds };
  },
  // getBet: (owner, betRound, bulb, status, cls, litBefore, night, stake, cumBefore), a static tuple
  bet(data) {
    const w = need(words(data), 9, 'getBet');
    return { owner: toAddr(w[0]), betRound: num(w[1]), bulb: num(w[2]), status: num(w[3]), cls: num(w[4]), litBefore: num(w[5]), night: num(w[6]), stake: w[7], cumBefore: w[8] };
  },
  // getNight: (start, c, stops, spanEnd, lastBetRound, betEnd, result, sumW, winStake, loseStake, bonusIn, burned)
  night(data) {
    const w = need(words(data), 12, 'getNight');
    return { start: num(w[0]), c: num(w[1]), stops: w[2], spanEnd: num(w[3]), lastBetRound: num(w[4]), betEnd: num(w[5]), result: num(w[6]), sumW: w[7], winStake: w[8], loseStake: w[9], bonusIn: w[10], burned: w[11] };
  },
  // getWalker: (cursor, openStart, openStops, idleRun, lastActive, lastBetRound)
  walker(data) {
    const w = need(words(data), 6, 'getWalker');
    return { cursor: num(w[0]), openStart: num(w[1]), openStops: w[2], idleRun: num(w[3]), lastActive: num(w[4]), lastBetRound: num(w[5]) };
  },
  // betOutcome: (night, cls, result, payout, ready)
  outcome(data) {
    const w = need(words(data), 5, 'betOutcome');
    return { night: num(w[0]), cls: num(w[1]), result: num(w[2]), payout: w[3], ready: w[4] !== 0n };
  },
  // openNight: (start, litSoFar, quiet)
  openNight(data) {
    const w = need(words(data), 3, 'openNight');
    return { start: num(w[0]), litSoFar: num(w[1]), quiet: num(w[2]) };
  },
  // BetPlaced(uint256 indexed betId, address indexed owner, uint8 bulb, uint256 amount, uint256 betRound)
  betPlaced(log) {
    const w = need(words(log.data), 3, 'BetPlaced');
    return { betId: num(BigInt(log.topics[1])), owner: toAddr(BigInt(log.topics[2])), bulb: num(w[0]), stake: w[1], betRound: num(w[2]), block: log.blockNumber ? Number(log.blockNumber) : null, tx: log.transactionHash || null };
  },
};

// The reason inside revert data, if the page knows it: { name, args } or null.
export function decodeRevert(data) {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{8}/.test(data)) return null;
  const sel = data.slice(0, 10).toLowerCase(), name = ERRORS[sel];
  if (!name) return { name: 'Unknown', selector: sel, args: [] };
  const body = '0x' + data.slice(10);
  try {
    if (name === 'Error') {
      // Error(string): offset, length, bytes
      const w = words(body.slice(0, 2 + 128)), len = num(w[1]);
      const bytes = body.slice(2 + 128, 2 + 128 + len * 2);
      const text = decodeURIComponent(bytes.replace(/../g, '%$&'));
      return { name, args: [text] };
    }
    if (name === 'ERC20InsufficientBalance' || name === 'ERC20InsufficientAllowance') {
      const w = words(body);
      return { name, args: [toAddr(w[0]), w[1], w[2]] };
    }
    return { name, args: body.length > 2 ? words(body) : [] };
  } catch {
    return { name, args: [] };
  }
}

// Revert data hides in different places depending on the wallet and the node. Look for the first 0x string that
// starts with a 4-byte selector.
export function findRevertData(err, depth = 0) {
  if (!err || depth > 5) return null;
  if (typeof err === 'string') return /^0x[0-9a-fA-F]{8,}$/.test(err) ? err : null;
  if (typeof err !== 'object') return null;
  for (const key of ['data', 'error', 'originalError', 'cause', 'info', 'body']) {
    let v = err[key];
    if (typeof v === 'string' && key === 'body') { try { v = JSON.parse(v); } catch { continue; } }
    const found = findRevertData(v, depth + 1);
    if (found) return found;
  }
  if (typeof err.message === 'string') {
    const m = err.message.match(/0x[0-9a-fA-F]{8,}/);
    if (m && ERRORS[m[0].slice(0, 10).toLowerCase()]) return m[0];
  }
  return null;
}

// ---------------------------------------------------------------- JSON-RPC

export class RpcError extends Error {
  constructor(message, { code, data, transport } = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
    this.transport = !!transport; // true: the node couldn't be reached; false: the node answered with an error
  }
}

// A JSON-RPC client over a list of URLs. A URL that can't be reached (network error, timeout, HTTP error, rate
// limit) is skipped for the next one; an answer that is an error (a revert, a bad call) is returned as is.
export function createRpc(urls, { fetchFn = globalThis.fetch?.bind(globalThis), timeoutMs = 10_000 } = {}) {
  if (!Array.isArray(urls) || !urls.length) throw new Error('config.rpc needs at least one URL');
  let prefer = 0, nextId = 1, batchOk = true;

  async function post(body) {
    let last;
    for (let k = 0; k < urls.length; k++) {
      const i = (prefer + k) % urls.length;
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => ctl && ctl.abort(), timeoutMs);
      try {
        const res = await fetchFn(urls[i], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!Array.isArray(json) && json && json.error && isRateLimit(json.error)) throw new Error(json.error.message || 'rate limited');
        prefer = i;
        return json;
      } catch (e) {
        last = e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new RpcError(`could not reach the network (${last && last.message ? last.message : 'no answer'})`, { transport: true });
  }

  async function request(method, params = []) {
    const json = await post({ jsonrpc: '2.0', id: nextId++, method, params });
    if (json && json.error) throw new RpcError(json.error.message || 'RPC error', { code: json.error.code, data: json.error.data });
    if (!json || !('result' in json)) throw new RpcError('empty answer from the network', { transport: true });
    return json.result;
  }

  // Several requests in one round trip (chunks of 20). Each item comes back as { result } or { error }.
  // A node that refuses batches gets the requests one by one from then on.
  async function batch(calls, chunk = 20) {
    const out = [];
    for (let i = 0; i < calls.length; i += chunk) {
      const part = calls.slice(i, i + chunk);
      if (batchOk && part.length > 1) {
        const ids = part.map(() => nextId++);
        try {
          const json = await post(part.map((c, j) => ({ jsonrpc: '2.0', id: ids[j], method: c.method, params: c.params || [] })));
          if (Array.isArray(json)) {
            const byId = new Map(json.map((r) => [r.id, r]));
            if (ids.every((id) => byId.has(id))) {
              for (const id of ids) {
                const r = byId.get(id);
                out.push(r.error ? { error: new RpcError(r.error.message || 'RPC error', { code: r.error.code, data: r.error.data }) } : { result: r.result });
              }
              continue;
            }
          }
          batchOk = false;
        } catch (e) {
          if (e.transport) throw e;
          batchOk = false;
        }
      }
      for (const c of part) {
        try { out.push({ result: await request(c.method, c.params || []) }); } catch (e) { if (e.transport) throw e; out.push({ error: e }); }
      }
    }
    return out;
  }

  return { request, batch, urls };
}

function isRateLimit(error) {
  return error.code === 429 || error.code === -32005 || /rate limit|too many requests/i.test(error.message || '');
}

// ---------------------------------------------------------------- the chain

// config: { chainId, rpc: [urls], squeekCore, sqk, lightsOn, deployBlock, statusApi?, explorer? }
export function createChain(config, { fetchFn = globalThis.fetch?.bind(globalThis), timeoutMs } = {}) {
  const rpc = createRpc(config.rpc, { fetchFn, timeoutMs });
  const call = (to, data, from, gas) => rpc.request('eth_call', [{ ...(from ? { from } : {}), to, data, ...(gas ? { gas: '0x' + Number(gas).toString(16) } : {}) }, 'latest']);
  const calls = async (list) => {
    const res = await rpc.batch(list.map(([to, data]) => ({ method: 'eth_call', params: [{ to, data }, 'latest'] })));
    return res.map((r) => { if (r.error) throw r.error; return r.result; });
  };
  const lightsOn = isAddress(config.lightsOn) ? config.lightsOn : null;

  const core = {
    async state() { return decode.state(await call(config.squeekCore, SEL.state)); },
    async roundPage(after, through, max = 16) { return decode.roundPage(await call(config.squeekCore, encode.roundPage(after, through, max))); },
    // Active rounds in (after, through], with his turns in each: [{ id, work }]. Turns come from the cumulative
    // work: rounds without a record are idle, so a record's work is its cumulative minus the one before it.
    async activeRounds(after, through, { maxPages = 500 } = {}) {
      const out = [];
      let cursor = after;
      for (let pages = 0; cursor < through; pages++) {
        if (pages >= maxPages) throw new Error(`more than ${maxPages} pages of rounds`);
        const page = await core.roundPage(cursor, through, 16);
        if (page.certifiedThrough <= cursor || page.certifiedThrough > through) throw new Error(`SqueekCore sent a page that certifies ${page.certifiedThrough} after ${cursor}`);
        let prev = page.start.cumulativeWork, prevId = cursor;
        for (const r of page.rounds) {
          if (r.roundId <= prevId || r.roundId > page.certifiedThrough) throw new Error(`SqueekCore sent round ${r.roundId} out of order`);
          out.push({ id: r.roundId, work: Number(r.cumulativeWork - prev) });
          prev = r.cumulativeWork;
          prevId = r.roundId;
        }
        cursor = page.certifiedThrough;
      }
      return out;
    },
  };

  const sqk = {
    async balanceOf(owner) { return decode.uint(await call(config.sqk, encode.balanceOf(owner))); },
    async allowance(owner, spender) { return decode.uint(await call(config.sqk, encode.allowance(owner, spender))); },
  };

  const lights = {
    address: lightsOn,
    // Values fixed at deployment.
    async constants() {
      const [g, station, min, max, coreAddr, sqkAddr, start] = await calls([[lightsOn, SEL.G], [lightsOn, SEL.STATION], [lightsOn, SEL.MIN_BET], [lightsOn, SEL.MAX_BET], [lightsOn, SEL.CORE], [lightsOn, SEL.SQK], [lightsOn, SEL.START_ROUND]]);
      return { genesis: num(decode.uint(g)), station: num(decode.uint(station)), minBet: decode.uint(min), maxBet: decode.uint(max), core: decode.address(coreAddr), sqk: decode.address(sqkAddr), startRound: num(decode.uint(start)) };
    },
    // Everything that changes, in one round trip.
    async snapshot() {
      const [pot, next, bets, nights, voided, walker, open] = await calls([[lightsOn, SEL.bonusPot], [lightsOn, SEL.nextSettle], [lightsOn, SEL.betCount], [lightsOn, SEL.nightCount], [lightsOn, SEL.voided], [lightsOn, SEL.getWalker], [lightsOn, SEL.openNight]]);
      return { bonusPot: decode.uint(pot), nextSettle: num(decode.uint(next)), betCount: num(decode.uint(bets)), nightCount: num(decode.uint(nights)), voided: decode.bool(voided), walker: decode.walker(walker), openNight: decode.openNight(open) };
    },
    // What ending the game needs right now: { asleepTooLong, stalled, flaggedAt } (flaggedAt: unix seconds, 0 = no
    // flag). The page only asks when it sees a reason (a core a day behind, or a week without a running round).
    async endState() {
      const [asleep, flagged] = await calls([[lightsOn, SEL.asleepTooLong], [lightsOn, SEL.stallFlaggedAt]]);
      const stalled = decode.bool(await call(lightsOn, SEL.stalled, null, STALL_READ_GAS));
      return { asleepTooLong: decode.bool(asleep), stalled, flaggedAt: num(decode.uint(flagged)) };
    },
    async night(id) { return decode.night(await call(lightsOn, encode.getNight(id))); },
    async bets(from, to) {
      const ids = [];
      for (let i = from; i < to; i++) ids.push(i);
      return lights.betsById(ids);
    },
    async betsById(ids) {
      const res = await calls(ids.map((i) => [lightsOn, encode.getBet(i)]));
      return res.map((d, k) => ({ id: ids[k], ...decode.bet(d) }));
    },
    async outcomes(ids) {
      const res = await calls(ids.map((i) => [lightsOn, encode.betOutcome(i)]));
      return res.map((d, k) => ({ id: ids[k], ...decode.outcome(d) }));
    },
    async lastBet(owner) { return num(decode.uint(await call(lightsOn, encode.lastBet(owner)))); },
    // Bet ids placed by `owner`, from BetPlaced logs (owner is indexed). Returns null if the logs can't be read;
    // the page then falls back to the bets it reads anyway.
    async betIdsOf(owner, { fromBlock = Number(config.deployBlock) || 0, chunk = 20_000 } = {}) {
      if (!fromBlock) return null;
      const latest = Number(await rpc.request('eth_blockNumber'));
      const out = [];
      let from = fromBlock, size = chunk;
      while (from <= latest) {
        const to = Math.min(latest, from + size - 1);
        try {
          const logs = await rpc.request('eth_getLogs', [{ address: lightsOn, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [TOPIC.BetPlaced, null, encode.topicAddress(owner)] }]);
          for (const l of logs) out.push(decode.betPlaced(l));
          from = to + 1;
        } catch (e) {
          // a node that pruned old history ("pruned history unavailable") answers the same for any smaller range
          if (/prun|history|not available|unavailable/i.test(String(e && (e.message || e)))) return null;
          if (size <= 500) return null;
          size = Math.floor(size / 2);
        }
      }
      return out;
    },
  };

  async function latestBlock() {
    const b = await rpc.request('eth_getBlockByNumber', ['latest', false]);
    return { number: Number(b.number), timestamp: Number(b.timestamp) };
  }

  // The wheel right now, from Squeekchain's status API. Only `speedMmPerSecond` on a fresh reading is used:
  // speed > 0 = running. coreStatus is never read (it flips while he runs). Freshness uses the API's own clock.
  async function wheel() {
    const url = config.statusApi || DEFAULT_STATUS_API;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), 8000);
    try {
      const res = await fetchFn(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      return readWheel(j);
    } finally {
      clearTimeout(timer);
    }
  }

  // test ETH (for the network fees) an address holds, in wei
  async function ethBalance(owner) { return BigInt(await rpc.request('eth_getBalance', [owner, 'latest'])); }

  return { config, rpc, call, calls, core, sqk, lights, latestBlock, wheel, ethBalance, chainId: async () => Number(await rpc.request('eth_chainId')) };
}

export function readWheel(j, nowMs = Date.now()) {
  const m = (j && j.measurement) || {};
  const speed = Number(m.speedMmPerSecond);
  const observed = Date.parse(m.observedAt);
  const ref = Date.parse(j && j.generatedAt) || nowMs;
  const staleAfter = Number(m.staleAfterSeconds) || 120;
  const fresh = Number.isFinite(observed) && Number.isFinite(speed) && ref - observed >= -60_000 && ref - observed <= staleAfter * 1000;
  // work: his turns so far on the wheel's counter, the same counter SqueekCore records (state().cumulativeWork at
  // the end of every recorded round); null when the reading has none. age: seconds the reading is older than the
  // answer (the server's own clocks, so a device clock that is off doesn't matter).
  const work = Number(m.cumulativeWorkUnits);
  return { fresh, running: fresh && speed > 0, speed: Number.isFinite(speed) ? speed : 0, rpm: Number(m.rpmMilli) / 1000 || 0, observedAt: Number.isFinite(observed) ? observed : null,
    work: m.cumulativeWorkUnits != null && Number.isFinite(work) && work >= 0 ? work : null, age: Number.isFinite(observed) ? Math.max(0, (ref - observed) / 1000) : 0 };
}

// ---------------------------------------------------------------- the wallet

export const hexChain = (id) => '0x' + Number(id).toString(16);

// A wallet session over an EIP-1193 provider. All sends go through the wallet; every write is first simulated
// with eth_call from the player's address on the page's own RPC, so a revert is explained before the wallet opens.
export function createWallet(provider, config, chain) {
  if (!provider || typeof provider.request !== 'function') throw new Error('no wallet');
  const want = Number(config.chainId);
  const req = (method, params) => provider.request(params ? { method, params } : { method });

  async function accounts() { const a = await req('eth_accounts'); return Array.isArray(a) ? a : []; }
  async function connect() {
    const a = await req('eth_requestAccounts');
    if (!Array.isArray(a) || !a.length) throw new Error('the wallet shared no account');
    return a[0];
  }
  async function chainId() { return Number(await req('eth_chainId')); }
  async function switchChain() {
    try {
      await req('wallet_switchEthereumChain', [{ chainId: hexChain(want) }]);
    } catch (e) {
      const code = e && (e.code ?? e.data?.originalError?.code);
      if (code !== 4902 && !/unrecognized|not been added|unknown chain/i.test(String(e && e.message))) throw e;
      await req('wallet_addEthereumChain', [{
        chainId: hexChain(want),
        chainName: config.chainName || (want === SEPOLIA_ID ? 'Sepolia' : `Chain ${want}`),
        nativeCurrency: { name: want === SEPOLIA_ID ? 'Sepolia Ether' : 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: config.rpc.filter((u) => /^https:/.test(u)).length ? config.rpc.filter((u) => /^https:/.test(u)) : config.rpc,
        blockExplorerUrls: config.explorer ? [config.explorer] : undefined,
      }]);
    }
    const now = await chainId();
    if (now !== want) throw Object.assign(new Error('wrong network'), { code: 'WRONG_NETWORK' });
  }
  // Simulate a write from `from`. Throws an Error with `.revert` = { name, args } when it would fail.
  async function preflight(from, to, data) {
    try {
      return await chain.call(to, data, from);
    } catch (e) {
      if (e.transport) throw e;
      const raw = findRevertData(e);
      throw Object.assign(new Error('this would fail'), { revert: decodeRevert(raw) || { name: 'Unknown', args: [] }, cause: e });
    }
  }
  // The same simulation through the wallet's own node (the one that just saw the player's transactions go through),
  // for when the page's node lags behind. Throws with `.revert` when it would fail, or with `.unsupported` when the
  // wallet doesn't answer reads or gives no reason.
  async function simulate(from, to, data) {
    try {
      return await req('eth_call', [{ from, to, data }, 'latest']);
    } catch (e) {
      const rev = decodeRevert(findRevertData(e));
      if (!rev || rev.name === 'Unknown') throw Object.assign(new Error('the wallet cannot check this'), { unsupported: true, cause: e });
      throw Object.assign(new Error('this would fail'), { revert: rev, cause: e });
    }
  }
  // `gas`: a fixed gas limit (only the gas used is paid). Without one the wallet estimates it.
  async function send(from, to, data, { gas } = {}) {
    const hash = await req('eth_sendTransaction', [gas ? { from, to, data, gas: hexChain(gas) } : { from, to, data }]);
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('the wallet returned no transaction');
    return hash;
  }
  // Polls for the receipt through the wallet, then through the page's RPC. Resolves { ok, receipt } or
  // { timeout: true } after `timeoutMs`.
  async function waitReceipt(hash, { timeoutMs = 180_000, everyMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      let r = null;
      try { r = await req('eth_getTransactionReceipt', [hash]); } catch { /* some wallets don't answer reads */ }
      if (!r) { try { r = await chain.rpc.request('eth_getTransactionReceipt', [hash]); } catch { /* try again */ } }
      if (r && r.blockNumber) return { ok: r.status === '0x1' || r.status === 1 || r.status === true, receipt: r };
      if (Date.now() >= until) return { timeout: true };
      await sleep(everyMs);
    }
  }
  const on = (event, fn) => { if (typeof provider.on === 'function') provider.on(event, fn); };
  // test ETH as the wallet's own node sees it (it may be ahead of the page's node); throws if the wallet won't say
  async function ethBalance(owner) { return BigInt(await req('eth_getBalance', [owner, 'latest'])); }
  return { provider, connect, accounts, chainId, switchChain, preflight, simulate, send, waitReceipt, on, ethBalance, wantChainId: want };
}

// ---------------------------------------------------------------- the two things a player does

// Gas limits (docs/lights-contract.md, "For the page"; audit A3). A bet that lands right after a blackout is recorded
// does more work than its estimate (it walks the new rounds), so bets and collects go out with fixed limits well above
// the worst case measured (652,228 for a bet, 443,304 for a collect). Only the gas used is paid.
export const GAS = { bet: 1_500_000, claimBase: 1_000_000, claimPerBet: 30_000 };
// after the allow step: how often, and how far apart, to look again for a node that hasn't seen it yet
export const ALLOW_LAG = { tries: 6, everyMs: 2500 };
const claimGas = (n) => GAS.claimBase + GAS.claimPerBet * n;
// The gas a bet or collect goes out with: the network's own estimate plus a quarter, never below the fixed limit above
// (that covers a blackout recorded between the estimate and the block). The fixed limits alone were too low on
// today's Sepolia when the game has many rounds to read first (a returning bettor ~2.6M, a late collect ~1.1M); the
// estimate sees that, including a core read that would starve. Capped well under a block.
export async function sendGas(chain, from, to, data, floor) {
  try {
    const est = Number(BigInt(await chain.rpc.request('eth_estimateGas', [{ from, to, data }])));
    return Math.min(Math.max(floor, Math.ceil(est * 1.25)), 15_000_000);
  } catch { return floor; }
}
// helpers (poke, settle): the estimate with room for rounds recorded meanwhile, or the wallet's own estimate
async function helperGas(chain, from, to, data) {
  try {
    const est = Number(BigInt(await chain.rpc.request('eth_estimateGas', [{ from, to, data }])));
    return Math.min(Math.ceil(est * 1.5) + 100_000, 12_000_000);
  } catch { return undefined; }
}
// After a transaction failed on chain, simulate it again to learn why (TooLate, AlreadyBet, ...), if it says: on the
// page's node first, then on the wallet's own node (the page's node may not have seen the block yet).
async function whyFailed(wallet, from, to, data) {
  try { await wallet.preflight(from, to, data); } catch (e) { if (e.revert && e.revert.name !== 'Unknown') return e; }
  if (typeof wallet.simulate === 'function') {
    try { await wallet.simulate(from, to, data); } catch (e) { if (e.revert && e.revert.name !== 'Unknown') return e; }
  }
  return null;
}
const isAllowanceRevert = (rev) => !!rev && (rev.name === 'ERC20InsufficientAllowance' || (rev.name === 'Error' && /allowance/i.test(rev.args[0] || '')));

// Places one bet: checks the SQK balance, simulates the bet (one bet per ride, limits), lets the game take exactly
// `amount` if it can't yet (never more, never unlimited), simulates again, sends the bet and waits for it.
// With `lastRound` (the round the page worked the lowest bulb out for, or a function that gives it now) the bet goes
// out as betUntil, so a bet that waits too long to be included fails (TooLate) instead of quietly landing in a later
// round or his next ride. A function is asked again for every simulation and for the bet itself, so a slow allow
// step doesn't make a bet that is still fine fail.
// If the game hasn't read every round the core has (PokeFirst, after a long busy spell nobody played in), it first
// sends a helper (poke) so the game catches up, at most `helpers` times.
// Right after the allow step, the page's node may not have seen it yet (public RPCs are several nodes; the Sepolia
// rehearsal hit this). The bet is then simulated on the wallet's own node, and the page's node is asked again for a
// while (ALLOW_LAG). If neither shows the allow in that time, it throws code ALLOW_SLOW (the allow went through, the
// network is slow): no second allow is asked for. `priorAllow` = { amount } is an allow the page saw go through on an
// earlier press (from onStep 'allowed'): the next press goes straight to the bet, and if the page's node still
// doesn't show it and the wallet can't check, the bet is sent anyway (the allow is confirmed, and the simulation
// only stopped at it, which the contract checks last).
// onStep(step, info) reports progress: 'check', 'catchup' (wallet asks for a helper), 'catching', 'allow' (wallet
// asks), 'allowing' (sent, waiting), 'allowed' (it went through: { hash, amount }), 'allowWait' (the page's node
// doesn't show it yet), 'bet', 'betting', 'done'. `beforeBet()` runs right before the bet is sent and may throw to
// stop it (the page re-checks the lowest bulb there, since the other steps can take a while); if it returns a number,
// that is the new lastRound. Returns { hash, betId, bet, balance, approveHash, helpers } (balance: SQK before the bet).
export async function placeBet({ chain, wallet, account, bulb, amount, lastRound = null, priorAllow = null, onStep = () => {}, beforeBet = async () => {}, waitOpts, helpers = 3 } = {}) {
  const game = chain.lights.address, token = chain.config.sqk;
  if (!game) throw new Error('no game contract');
  onStep('check');
  const balance = await chain.sqk.balanceOf(account);
  if (balance < amount) {
    throw Object.assign(new Error('not enough SQK'), { revert: { name: 'ERC20InsufficientBalance', args: [account, balance, amount] } });
  }
  let last = lastRound;
  const data = () => {
    const n = typeof last === 'function' ? last() : last;
    return n == null ? encode.bet(bulb, amount) : encode.betUntil(bulb, amount, n);
  };
  const simulate = async () => {
    try { await wallet.preflight(account, game, data()); return null; } catch (e) {
      if (isAllowanceRevert(e.revert)) return 'allow';
      if (e.revert && e.revert.name === 'PokeFirst') return 'catchup';
      throw e;
    }
  };
  // the bet on the wallet's own node: null = it would go through; 'no' = it doesn't show the allow either (or can't
  // say); 'unknown' = the wallet doesn't answer reads. Any other reason (AlreadyBet, TooLate, ...) is thrown.
  const viaWallet = async () => {
    if (typeof wallet.simulate !== 'function') return 'unknown';
    try { await wallet.simulate(account, game, data()); return null; } catch (e) {
      if (e.unsupported) return 'unknown';
      if (isAllowanceRevert(e.revert) || (e.revert && e.revert.name === 'PokeFirst')) return 'no';
      throw e;
    }
  };
  const wait = async (hash, what) => {
    const r = await wallet.waitReceipt(hash, waitOpts);
    if (r.timeout) throw Object.assign(new Error('still waiting'), { code: 'TIMEOUT', hash });
    if (!r.ok) throw Object.assign(new Error(`the ${what} step failed`), { code: 'FAILED', hash });
    return r;
  };
  const fromBefore = !!(priorAllow && BigInt(priorAllow.amount ?? 0) >= amount);
  let approveHash = null, allowed = fromBefore, lag = 0, walletSays = null;
  const helperHashes = [];
  const pause = (waitOpts && waitOpts.sleep) || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let s = await simulate(); ; s = await simulate()) {
    if (s === 'catchup') {
      if (helperHashes.length >= helpers) throw Object.assign(new Error('the game is still catching up'), { revert: { name: 'PokeFirst', args: [] } });
      const help = encode.poke(16);
      onStep('catchup', { step: helperHashes.length + 1 });
      const h = await wallet.send(account, game, help, { gas: await helperGas(chain, account, game, help) });
      helperHashes.push(h);
      onStep('catching', { hash: h });
      await wait(h, 'catch-up');
      continue;
    }
    if (s === 'allow' || (!allowed && (await chain.sqk.allowance(account, game)) < amount)) {
      if (allowed) {
        // the allow went through, but the page's node doesn't show it yet: ask the wallet's node (first and last
        // look), and look again on the page's node for a while
        if (lag === 0 || lag >= ALLOW_LAG.tries) {
          walletSays = await viaWallet();
          if (walletSays === null) break;
        }
        // an allow from an earlier press that the wallet's node says isn't there any more (used or changed
        // elsewhere): ask for it again
        if (fromBefore && !approveHash && lag === 0 && walletSays === 'no') allowed = false;
        else {
          if (lag >= ALLOW_LAG.tries) {
            // pressed again after "your allow went through", and the wallet can't check: send the bet
            if (fromBefore && !approveHash && walletSays === 'unknown') break;
            throw Object.assign(new Error('the allow is not seen yet'), { code: 'ALLOW_SLOW', hash: approveHash });
          }
          if (++lag === 1) onStep('allowWait', { hash: approveHash });
          await pause(ALLOW_LAG.everyMs);
          continue;
        }
      }
      onStep('allow', { amount });
      approveHash = await wallet.send(account, token, encode.approve(game, amount));
      onStep('allowing', { hash: approveHash });
      await wait(approveHash, 'allow');
      allowed = true;
      onStep('allowed', { hash: approveHash, amount });
      continue;
    }
    break;
  }
  const again = await beforeBet();
  if (typeof again === 'number' && last != null && typeof last !== 'function') last = again;
  onStep('bet', { bulb, amount });
  const tx = data();
  const hash = await wallet.send(account, game, tx, { gas: await sendGas(chain, account, game, tx, GAS.bet) });
  onStep('betting', { hash });
  const r = await wallet.waitReceipt(hash, waitOpts);
  if (r.timeout) throw Object.assign(new Error('still waiting'), { code: 'TIMEOUT', hash });
  if (!r.ok) {
    const why = await whyFailed(wallet, account, game, tx);
    throw why ? Object.assign(why, { hash }) : Object.assign(new Error('the bet failed'), { code: 'FAILED', hash });
  }
  const log = (r.receipt.logs || []).find((l) => l.topics && l.topics[0] === TOPIC.BetPlaced && l.address && l.address.toLowerCase() === game.toLowerCase());
  const placed = log ? decode.betPlaced(log) : null;
  onStep('done', { hash, bet: placed });
  return { hash, betId: placed ? placed.betId : null, bet: placed, balance, approveHash, helpers: helperHashes };
}

// Collects the winnings and refunds of `ids`. The contract only pays a bet once it has counted its ride, and it
// counts as people use it: each collect first reads up to 2 pages of rounds and counts up to 31 bets. So collect
// works right after the blackout even if nobody else has played since. It simulates first; when the simulation
// says nothing would be paid yet (a long gap, a busy ride), it sends one helper transaction to count the ride
// (`poke` reads rounds, `settle` counts bets), at most `helpers` times, then collects.
// onStep: 'check', 'count' (wallet asks for a helper), 'counting', 'collect', 'collecting', 'done'.
// Returns { hash, collected, paid: [{ id, amount, refunded }], helpers: [hashes] }.
export async function collect({ chain, wallet, account, ids, onStep = () => {}, waitOpts, helpers = 3 } = {}) {
  const game = chain.lights.address;
  const data = encode.claim(ids);
  const ready = async () => Number(decode.uint(await wallet.preflight(account, game, data)));
  onStep('check');
  let done = await ready();
  const helperHashes = [];
  for (let i = 0; done === 0 && i < helpers; i++) {
    const [snap, bets, outs] = [await chain.lights.snapshot(), await chain.lights.betsById(ids), await chain.lights.outcomes(ids)];
    // only bets whose ride isn't counted yet can be helped; collected bets and stakes riding in a bonus pot can't
    const uncounted = bets.filter((b, k) => b.status === STATUS.WAITING || (b.status === STATUS.COUNTED && outs[k].result === RESULT.SETTLING));
    if (snap.voided || !uncounted.length) break;
    const latest = Math.max(...uncounted.map((b) => b.betRound));
    // the walker hasn't closed the ride the bets are in yet: read rounds; otherwise count bets
    const help = snap.walker.lastBetRound < latest ? encode.poke(8) : encode.settle(400);
    onStep('count', { step: i + 1 });
    const h = await wallet.send(account, game, help, { gas: await helperGas(chain, account, game, help) });
    helperHashes.push(h);
    onStep('counting', { hash: h });
    const r = await wallet.waitReceipt(h, waitOpts);
    if (r.timeout) throw Object.assign(new Error('still waiting'), { code: 'TIMEOUT', hash: h });
    if (!r.ok) throw Object.assign(new Error('counting failed'), { code: 'FAILED', hash: h });
    done = await ready();
  }
  if (done === 0) throw Object.assign(new Error('nothing ready'), { code: 'NOT_READY' });
  onStep('collect', { count: done });
  const hash = await wallet.send(account, game, data, { gas: await sendGas(chain, account, game, data, claimGas(ids.length)) });
  onStep('collecting', { hash });
  const r = await wallet.waitReceipt(hash, waitOpts);
  if (r.timeout) throw Object.assign(new Error('still waiting'), { code: 'TIMEOUT', hash });
  if (!r.ok) throw Object.assign(new Error('collect failed'), { code: 'FAILED', hash });
  // what each bet paid (Claimed / Refunded: betId and owner are indexed), so the page can show it before its node does
  const paid = (r.receipt.logs || []).filter((l) => l.topics && (l.topics[0] === TOPIC.Claimed || l.topics[0] === TOPIC.Refunded) && l.address && l.address.toLowerCase() === game.toLowerCase())
    .map((l) => ({ id: num(BigInt(l.topics[1])), amount: decode.uint(l.data), refunded: l.topics[0] === TOPIC.Refunded }));
  const collected = paid.reduce((a, p) => a + p.amount, 0n);
  onStep('done', { hash, collected });
  return { hash, collected, paid, helpers: helperHashes };
}

// Ends the game, or flags a stalled core first (anyone may: no owner, no admin).
//   action 'flag': flagStall(), allowed while the core hasn't settled a round for STALL_ROUNDS. Returns { flagged }.
//   action 'end': void(), allowed when he hasn't run for SLEEP_ROUNDS, or VOID_DELAY after a flag if the core is still
//     stuck the same way. void() needs every round the core can serve read (poke) and every closed night counted
//     (settle) first: those helpers go out first, at most `helpers`. void() can also go through WITHOUT ending the
//     game: if the core settled again since the flag, it clears the flag. So the result is read back from the
//     contract: { ended: true } or { cleared: true }.
// onStep: 'check', 'catchup' / 'catching' (poke), 'count' / 'counting' (settle), 'end' / 'ending', 'flag' /
// 'flagging', 'done'.
export async function endGame({ chain, wallet, account, action = 'end', onStep = () => {}, waitOpts, helpers = 12 } = {}) {
  const game = chain.lights.address;
  if (!game) throw new Error('no game contract');
  const sendAndWait = async (data, gas, [ask, wait]) => {
    onStep(ask);
    const h = await wallet.send(account, game, data, { gas });
    onStep(wait, { hash: h });
    const r = await wallet.waitReceipt(h, waitOpts);
    if (r.timeout) throw Object.assign(new Error('still waiting'), { code: 'TIMEOUT', hash: h });
    if (!r.ok) {
      const why = await whyFailed(wallet, account, game, data);
      throw why || Object.assign(new Error('failed'), { code: 'FAILED', hash: h });
    }
    return { hash: h, receipt: r.receipt };
  };
  const emitted = (receipt, topic) => (receipt?.logs || []).some((l) => l.topics && l.topics[0] === topic && l.address && l.address.toLowerCase() === game.toLowerCase());
  onStep('check');
  if (action === 'flag') {
    const data = encode.flagStall();
    await wallet.preflight(account, game, data); // NotStalled / IsVoided in plain words before the wallet asks
    const { hash } = await sendAndWait(data, await sendGas(chain, account, game, data, STALL_READ_GAS + 200_000), ['flag', 'flagging']);
    onStep('done', { hash });
    return { hash, flagged: true };
  }
  const data = encode.voidGame();
  const helperHashes = [];
  for (let i = 0; ; i++) {
    // read every round the core can serve, then count every closed night: void() refuses until both are done
    const [snap, core] = [await chain.lights.snapshot(), await chain.core.state().catch(() => null)];
    if (snap.voided) throw Object.assign(new Error('already ended'), { revert: { name: 'IsVoided', args: [] } });
    const behind = core && snap.walker.cursor < core.settledThrough;
    const uncounted = snap.nextSettle < snap.nightCount;
    if (!behind && !uncounted) break;
    if (i >= helpers) throw Object.assign(new Error('still catching up'), { code: 'NOT_READY' });
    const help = behind ? encode.poke(8) : encode.settle(400);
    helperHashes.push((await sendAndWait(help, await helperGas(chain, account, game, help), behind ? ['catchup', 'catching'] : ['count', 'counting'])).hash);
  }
  await wallet.preflight(account, game, data); // TooEarly / SettleFirst / IsVoided in plain words before the wallet asks
  const { hash, receipt } = await sendAndWait(data, await sendGas(chain, account, game, data, STALL_READ_GAS + 500_000), ['end', 'ending']);
  // from the transaction's own events, not a read: the page's node may not have seen the block yet
  const ended = emitted(receipt, TOPIC.Voided);
  if (!ended && !emitted(receipt, TOPIC.StallCleared)) throw Object.assign(new Error('no result'), { code: 'FAILED', hash });
  onStep('done', { hash, ended });
  return ended ? { hash, ended: true, helpers: helperHashes } : { hash, cleared: true, helpers: helperHashes };
}

// ---------------------------------------------------------------- plain words for failures

const sqkText = (wei) => {
  const whole = wei / 10n ** 18n, frac = (wei % 10n ** 18n) / 10n ** 16n;
  return `${whole.toLocaleString('en-US')}${frac ? '.' + String(frac).padStart(2, '0').replace(/0$/, '') : ''}`;
};

// { kind, text } for anything a wallet, the node or the contract threw.
export function explain(err) {
  if (!err) return { kind: 'unknown', text: 'Something went wrong. Please try again.' };
  const code = err.code ?? err.cause?.code ?? err.data?.originalError?.code;
  const msg = String(err.message || err);
  if (code === 4001 || code === 'ACTION_REJECTED' || /user (rejected|denied)|rejected the request|denied transaction/i.test(msg)) {
    return { kind: 'rejected', text: 'You said no in your wallet, so nothing was sent.' };
  }
  if (code === -32002) return { kind: 'pending', text: 'Your wallet already has a request waiting. Open your wallet to answer it.' };
  if (code === 'WRONG_NETWORK') return { kind: 'network', text: 'Your wallet is on another network. Switch it to Sepolia (the test network) to play.' };
  if (code === 'TIMEOUT') return { kind: 'timeout', text: 'Your wallet sent it, but the network hasn\'t confirmed it yet. It may still go through; the page will show it when it does.' };
  if (code === 'FAILED') return { kind: 'failed', text: 'It didn\'t go through, so nothing changed. Please try again.' };
  if (code === 'ALLOW_SLOW') return { kind: 'allowSlow', text: 'Your allow went through, but the network is slow to show it. Press the button again in a moment to place your bet; your wallet won\'t ask to allow again.' };
  if (code === 'NOT_READY') return { kind: 'counting', text: 'There is nothing to collect yet: the game hasn\'t finished counting that ride. Try again in a minute.' };
  if (code === 4100) return { kind: 'locked', text: 'Your wallet is locked or hasn\'t shared an account with this page. Unlock it and connect again.' };
  if (/insufficient funds/i.test(msg)) return { kind: 'gas', text: 'Your wallet needs a little Sepolia ETH to pay the network fee. Test ETH is free from a Sepolia faucet.' };
  const rev = err.revert || decodeRevert(findRevertData(err));
  if (rev) {
    switch (rev.name) {
      case 'AlreadyBet': return { kind: 'already', text: 'You already have a bet on this ride. It\'s one bet per ride; you can bet again on his next one.' };
      case 'TooLate': return { kind: 'late', text: 'Your bet reached the network too late for the round it was meant for, so it wasn\'t placed. Check your bulb and press the button again.' };
      case 'PokeFirst': return { kind: 'catchup', text: 'The game is still catching up with his latest rounds. Please try again in a moment.' };
      case 'BadAmount': return { kind: 'amount', text: 'A bet must be between 10 and 10,000 SQK.' };
      case 'BadBulb': return { kind: 'bulb', text: 'Pick a bulb from 1 to 24.' };
      case 'IsVoided': return { kind: 'ended', text: 'This game has ended. You can still collect your refunds.' };
      case 'TooEarly': return { kind: 'early', text: 'The game can\'t be ended yet: that needs a week without him running, or a day after a stall was flagged.' };
      case 'NotStalled': return { kind: 'notStalled', text: 'Squeekchain is recording rounds again, so there is no stall to flag.' };
      case 'SettleFirst': return { kind: 'catchup', text: 'The game still has rides to count before it can end. Press the button again: it counts them first.' };
      case 'NeedMoreGas': return { kind: 'gas', text: 'Your wallet sent this with too little gas for the game\'s check of Squeekchain. Press the button again.' };
      case 'BeforeGenesis': return { kind: 'early', text: 'Squeekchain hasn\'t started its rounds yet.' };
      case 'ERC20InsufficientBalance': return { kind: 'balance', text: `Not enough SQK: you have ${sqkText(rev.args[1])}, this bet needs ${sqkText(rev.args[2])}.` };
      case 'ERC20InsufficientAllowance': return { kind: 'allowance', text: 'The game wasn\'t allowed to take this bet from your SQK yet. Press the button again to allow it.' };
      case 'Error':
        if (/balance/i.test(rev.args[0])) return { kind: 'balance', text: 'Not enough SQK for this bet.' };
        if (/allowance/i.test(rev.args[0])) return { kind: 'allowance', text: 'The game wasn\'t allowed to take this bet from your SQK yet. Press the button again to allow it.' };
        return { kind: 'revert', text: `The network refused this: ${rev.args[0] || 'no reason given'}.` };
      default: return { kind: 'revert', text: 'The network refused this transaction, so nothing changed.' };
    }
  }
  if (err.transport || /fetch|network|timeout|aborted/i.test(msg)) return { kind: 'offline', text: 'Couldn\'t reach the network. Check your connection and try again.' };
  return { kind: 'unknown', text: 'Something went wrong in your wallet. Nothing was sent. Please try again.' };
}
