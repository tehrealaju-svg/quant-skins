// Quant client library: keys, addresses, amounts, transactions. Shared by the website and the
// browser extension. All signing happens here, in the user's browser; only signed transactions
// leave the device. Amounts are BigInt base units (QNT has 10 decimals).
import { WORDS } from "./words.js";

// ---------------------------------------------------------------- bytes / hex
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function unhex(s) {
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error("bad hex");
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.substr(i * 2, 2), 16);
  return b;
}
const utf8 = (s) => new TextEncoder().encode(s);
export function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export const ZERO32 = new Uint8Array(32);
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---------------------------------------------------------------- WASM crypto
let W = null; // wasm exports
export async function loadCrypto(source) {
  if (W) return;
  const imports = { env: { js_random: (ptr, n) => crypto.getRandomValues(new Uint8Array(W.memory.buffer, ptr, n)) } };
  let inst;
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) inst = (await WebAssembly.instantiate(source, imports)).instance;
  else {
    const res = await fetch(source || new URL("../qcrypto.wasm", import.meta.url));
    inst = (await WebAssembly.instantiate(await res.arrayBuffer(), imports)).instance;
  }
  W = inst.exports;
}
function put(bytes) { const p = W.qc_alloc(bytes.length || 1); new Uint8Array(W.memory.buffer, p, bytes.length).set(bytes); return p; }
function cstr(s) { return put(concat(utf8(s), new Uint8Array([0]))); }
function take(p, n) { return new Uint8Array(W.memory.buffer, p, n).slice(); }

export function blake3Tagged(ctx, data, outlen = 32) {
  W.qc_reset();
  const c = cstr(ctx), d = put(data), o = W.qc_alloc(outlen);
  W.qc_blake3_tagged(c, d, data.length, o, outlen);
  return take(o, outlen);
}
export const FALCON_PK = 897, FALCON_SK = 1281, FALCON_SIG_MAX = 752;
export function keypair(master, index) {
  W.qc_reset();
  const m = put(master), pk = W.qc_alloc(FALCON_PK), sk = W.qc_alloc(FALCON_SK);
  if (W.qc_keypair(m, index >>> 0, pk, sk) !== 0) throw new Error("keygen failed");
  return { pk: take(pk, FALCON_PK), sk: take(sk, FALCON_SK) };
}
export function sign(sk, msg32) {
  W.qc_reset();
  const s = put(sk), m = put(msg32), o = W.qc_alloc(FALCON_SIG_MAX);
  const n = W.qc_sign(s, m, o);
  if (!n) throw new Error("signing failed");
  return take(o, n);
}
export function verify(pk, sig, msg32) {
  W.qc_reset();
  return W.qc_verify(put(pk), put(sig), sig.length, put(msg32)) === 1;
}
// Seed words (+ optional passphrase) -> 32-byte wallet master key. ~100k hashes: run it once.
export function masterKey(words, passphrase = "") {
  W.qc_reset();
  const s = concat(utf8(normalizeWords(words)), new Uint8Array([0]), utf8(passphrase));
  const p = put(s), o = W.qc_alloc(32);
  W.qc_master(p, s.length, o);
  return take(o, 32);
}

export const CTX = {
  TXID: "Quant v2 txid", WTXID: "Quant v2 witness", SIGHASH: "Quant v2 sighash", ADDRESS: "Quant v2 address",
  ASSET: "Quant v2 token id", LPTOKEN: "Quant v2 pool share id",
};
export const addressHash = (pk) => blake3Tagged(CTX.ADDRESS, pk);

// ---------------------------------------------------------------- seed words (BIP-39 list, 24 words)
export const normalizeWords = (s) => s.trim().toLowerCase().split(/\s+/).join(" ");
async function sha256(b) { return new Uint8Array(await crypto.subtle.digest("SHA-256", b)); }
export async function generateWords() {
  const ent = crypto.getRandomValues(new Uint8Array(32));
  const cs = (await sha256(ent))[0];
  const bits = concat(ent, new Uint8Array([cs]));
  const words = [];
  for (let i = 0; i < 24; i++) {
    let v = 0;
    for (let j = 0; j < 11; j++) { const bit = i * 11 + j; v = (v << 1) | ((bits[bit >> 3] >> (7 - (bit & 7))) & 1); }
    words.push(WORDS[v]);
  }
  return words.join(" ");
}
export async function validWords(s) {
  const w = normalizeWords(s).split(" ");
  if (w.length !== 24) return false;
  const bits = new Uint8Array(33);
  for (let i = 0; i < 24; i++) {
    const idx = WORDS.indexOf(w[i]);
    if (idx < 0) return false;
    for (let j = 0; j < 11; j++) if ((idx >> (10 - j)) & 1) { const bit = i * 11 + j; bits[bit >> 3] |= 1 << (7 - (bit & 7)); }
  }
  return (await sha256(bits.slice(0, 32)))[0] === bits[32];
}
export const isWord = (w) => WORDS.includes(w.toLowerCase());
export { WORDS };

// ---------------------------------------------------------------- bech32m addresses
const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const B32M = 0x2bc830a3;
function polymod(v) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let c = 1;
  for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >> i) & 1) c ^= G[i]; }
  return c >>> 0;
}
const hrpExpand = (h) => [...[...h].map((c) => c.charCodeAt(0) >> 5), 0, ...[...h].map((c) => c.charCodeAt(0) & 31)];
function convert(data, from, to, pad) {
  let acc = 0, bits = 0; const out = []; const max = (1 << to) - 1;
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & max); } }
  if (pad) { if (bits) out.push((acc << (to - bits)) & max); } else if (bits >= from || ((acc << (to - bits)) & max)) return null;
  return out;
}
export function encodeAddress(hrp, hash32, ver = 0) {
  const d5 = convert(concat(new Uint8Array([ver]), hash32), 8, 5, true);
  const chk = polymod([...hrpExpand(hrp), ...d5, 0, 0, 0, 0, 0, 0]) ^ B32M;
  const cs = [0, 1, 2, 3, 4, 5].map((i) => (chk >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...d5, ...cs].map((x) => B32[x]).join("");
}
export function decodeAddress(hrp, s) {
  s = s.trim().toLowerCase();
  const pos = s.lastIndexOf("1");
  if (pos < 1 || s.slice(0, pos) !== hrp) return null;
  const d = [...s.slice(pos + 1)].map((c) => B32.indexOf(c));
  if (d.length < 6 || d.some((x) => x < 0)) return null;
  if (polymod([...hrpExpand(hrp), ...d]) !== B32M) return null;
  const d8 = convert(d.slice(0, -6), 5, 8, false);
  if (!d8 || d8.length !== 33 || d8[0] !== 0) return null;
  return new Uint8Array(d8.slice(1));
}
export const HRP = { main: "qnt", test: "tqnt", regtest: "rqnt" };

// ---------------------------------------------------------------- amounts
export const COIN = 10_000_000_000n;
export const DUST = 10_000n;
export const MIN_FEE_PER_KB = 100_000n;
export function formatUnits(v, dec = 10) {
  v = BigInt(v);
  const neg = v < 0n; if (neg) v = -v;
  const base = 10n ** BigInt(dec);
  let s = (v / base).toString();
  if (dec > 0) { const f = (v % base).toString().padStart(dec, "0").replace(/0+$/, ""); if (f) s += "." + f; }
  return (neg ? "-" : "") + s;
}
export function parseUnits(s, dec = 10) {
  s = String(s).trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [i, f = ""] = s.split(".");
  if (f.length > dec) return null;
  const v = BigInt(i || "0") * 10n ** BigInt(dec) + BigInt((f + "0".repeat(dec)).slice(0, dec) || "0");
  return v >= 1n << 64n ? null : v;
}

// ---------------------------------------------------------------- serialization
class Writer {
  constructor() { this.b = []; }
  u8(v) { this.b.push(v & 255); }
  u32le(v) { for (let i = 0; i < 4; i++) this.b.push((v >>> (8 * i)) & 255); }
  varint(v) { v = BigInt(v); while (v >= 0x80n) { this.b.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; } this.b.push(Number(v)); }
  raw(u8) { for (const x of u8) this.b.push(x); }
  bytes(u8) { this.varint(u8.length); this.raw(u8); }
  str(s) { this.bytes(utf8(s)); }
  out() { return new Uint8Array(this.b); }
}
const isQnt = (asset) => !asset || eq(asset, ZERO32);
function writeOut(w, o) {
  w.varint(o.value);
  if (isQnt(o.asset)) w.u8(0); else { w.u8(1); w.raw(o.asset); }
  w.raw(o.addr);
}
function writeOp(w, op) {
  switch (op.type) {
    case "create": w.u8(1); w.str(op.ticker); w.str(op.name); w.u8(op.decimals); w.varint(op.supply); w.str(op.uri || ""); break;
    case "poolCreate": w.u8(2); w.raw(op.token); w.varint(op.qnt); w.varint(op.tok); w.varint(op.shares); break;
    case "add": w.u8(3); w.raw(op.token); w.varint(op.qnt); w.varint(op.tok); w.varint(op.shares); break;
    case "remove": w.u8(4); w.raw(op.token); w.varint(op.shares); w.varint(op.qnt); w.varint(op.tok); break;
    case "swap": w.u8(5); w.raw(op.token); w.u8(op.sell ? 1 : 0); w.varint(op.in); w.varint(op.out); break;
    default: throw new Error("unknown op " + op.type);
  }
}
export function txCore(tx) {
  const w = new Writer();
  w.varint(2);
  w.varint(tx.ins.length);
  for (const i of tx.ins) { w.raw(i.txid); w.varint(i.n); }
  w.varint(tx.outs.length);
  for (const o of tx.outs) writeOut(w, o);
  w.varint(tx.ops.length);
  for (const op of tx.ops) writeOp(w, op);
  w.varint(0); // lock_height
  w.bytes(new Uint8Array(0)); // extra
  return w.out();
}
export function txWitness(tx) {
  const w = new Writer();
  w.varint(tx.witness.length);
  for (const x of tx.witness) {
    if (x.ref !== undefined) { w.u8(0); w.varint(x.ref); }
    else { w.u8(1); w.raw(x.pk); w.bytes(x.sig); }
  }
  return w.out();
}
export const txid = (tx) => blake3Tagged(CTX.TXID, txCore(tx));
export const txHex = (tx) => hex(concat(txCore(tx), txWitness(tx)));
export function tokenId(firstIn, opIndex) {
  const w = new Writer(); w.raw(firstIn.txid); w.u32le(firstIn.n); w.u32le(opIndex);
  return blake3Tagged(CTX.ASSET, w.out());
}
export const poolShareId = (token) => blake3Tagged(CTX.LPTOKEN, token);

// ---------------------------------------------------------------- AMM math (mirrors consensus)
export const POOL_FEE_BPS = 30n, MIN_LIQUIDITY = 1000n;
export function ammQuote(inp, rin, rout) {
  inp = BigInt(inp); rin = BigInt(rin); rout = BigInt(rout);
  if (!inp || !rin || !rout) return 0n;
  const f = inp * (10000n - POOL_FEE_BPS);
  return (f * rout) / (rin * 10000n + f);
}
export function isqrt(n) { if (n < 2n) return n; let x = 1n << BigInt((n.toString(2).length + 1) >> 1); for (;;) { const y = (x + n / x) >> 1n; if (y >= x) break; x = y; } while (x * x > n) x--; return x; }
export const ammInitialShares = (q, t) => isqrt(BigInt(q) * BigInt(t));
export function ammAddShares(pool, q, t) {
  const a = (BigInt(q) * pool.shares) / pool.qnt, b = (BigInt(t) * pool.shares) / pool.tok;
  return a < b ? a : b;
}

// ---------------------------------------------------------------- transaction building
// coins: [{txid: Uint8Array, n, value: BigInt, asset: Uint8Array|null, addr: Uint8Array, mature, height}]
// keys:  Map(hex(addr) -> {pk, sk}). plan: {outs, ops, opIn: Map(hexAsset->BigInt), opOut: Map, finish(tx),
// extraOuts, subtractFee}. changeAddr: Uint8Array. Returns {tx, fee, hex, txid}.
function estimateSize(nIn, nUnique, nOut, nOps) {
  return 8 + nIn * 37 + nOut * 74 + nOps * 160 + 4 + 3 + nUnique * (1 + FALCON_PK + 2 + FALCON_SIG_MAX) + (nIn - nUnique) * 4;
}
export function buildTx({ plan, coins, keys, changeAddr, genesis, feePerKb = MIN_FEE_PER_KB }) {
  if (feePerKb < MIN_FEE_PER_KB) feePerKb = MIN_FEE_PER_KB;
  const QK = hex(ZERO32);
  const need = new Map();
  const add = (k, v) => need.set(k, (need.get(k) || 0n) + v);
  for (const o of plan.outs) add(hex(o.asset || ZERO32), BigInt(o.value));
  for (const [k, v] of plan.opIn || []) add(k, BigInt(v));
  for (const [k, v] of plan.opOut || []) add(k, -BigInt(v));
  const usable = coins.filter((c) => c.mature !== false && !c.locked);
  const sel = [], change = [];
  for (const [asset, n] of need) {
    if (asset === QK) continue;
    let have = 0n;
    if (n > 0n) {
      const pool = usable.filter((c) => hex(c.asset || ZERO32) === asset).sort((a, b) => (b.value > a.value ? 1 : -1));
      for (const c of pool) { if (have >= n) break; sel.push(c); have += c.value; }
      if (have < n) throw new Error("Not enough of that token");
    }
    if (have - n > 0n) change.push({ value: have - n, asset: unhex(asset) });
  }
  const qpool = usable.filter((c) => isQnt(c.asset)).sort((a, b) => (b.value > a.value ? 1 : -1));
  const qneed = need.get(QK) || 0n;
  let qhave = 0n, fee = 0n, qi = 0, qcount = 0;
  const unique = () => Math.max(new Set(sel.map((c) => hex(c.addr))).size, 1);
  for (;;) {
    const nOut = plan.outs.length + change.length + (plan.extraOuts || 0) + 1;
    fee = (BigInt(estimateSize(Math.max(sel.length, 1), unique(), nOut, plan.ops.length)) * feePerKb) / 1000n;
    const want = plan.subtractFee ? qneed : qneed + fee;
    if (qcount > 0 && qhave >= want) break;
    if (qi >= qpool.length) throw new Error(`Not enough QNT: have ${formatUnits(qhave)}, need ${formatUnits(want > 0n ? want : 0n)}`);
    sel.push(qpool[qi]); qhave += qpool[qi].value; qi++; qcount++;
    if (sel.length > 500) throw new Error("Too many small coins");
  }
  const tx = { ins: sel.map((c) => ({ txid: c.txid, n: c.n })), outs: plan.outs.map((o) => ({ ...o, value: BigInt(o.value) })), ops: plan.ops, witness: [] };
  if (plan.subtractFee) {
    if (tx.outs[0].value <= fee + DUST) throw new Error("Amount too small to cover the fee");
    tx.outs[0].value -= fee;
  }
  const qchange = qhave - qneed - (plan.subtractFee ? 0n : fee);
  if (qchange >= DUST) change.push({ value: qchange, asset: null });
  for (const c of change) tx.outs.push({ value: c.value, asset: c.asset, addr: changeAddr });
  if (plan.finish) plan.finish(tx);
  // Sign: one Falcon signature per distinct address, later inputs reference it.
  const id = txid(tx);
  const sighash = blake3Tagged(CTX.SIGHASH, concat(genesis, id));
  const first = new Map();
  sel.forEach((c, i) => {
    const a = hex(c.addr);
    if (first.has(a)) { tx.witness.push({ ref: first.get(a) }); return; }
    const k = keys.get(a);
    if (!k) throw new Error("Missing key for a coin");
    tx.witness.push({ pk: k.pk, sig: sign(k.sk, sighash) });
    first.set(a, i);
  });
  const opQ = (plan.opOut?.get(QK) || 0n) - (plan.opIn?.get(QK) || 0n);
  const outQ = tx.outs.filter((o) => isQnt(o.asset)).reduce((a, o) => a + o.value, 0n);
  return { tx, fee: qhave + opQ - outQ, hex: txHex(tx), txid: hex(id) };
}

// ---------------------------------------------------------------- node API
export class NodeApi {
  constructor(url) { this.url = url; }
  async call(method, params = []) {
    const r = await fetch(this.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, params, id: 1 }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.result;
  }
}
// Convert getaddresscoins output to buildTx coins.
export function coinsFromApi(list, addrHash) {
  return list.map((c) => ({
    txid: unhex(c.txid), n: c.vout, value: BigInt(c.units), asset: c.asset_id ? unhex(c.asset_id) : null,
    addr: addrHash, mature: c.mature, height: c.height,
  }));
}
