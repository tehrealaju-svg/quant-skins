// Browser wallet: seed words encrypted with the user's password (PBKDF2 + AES-GCM) in this
// browser's storage. Keys are derived exactly like the desktop wallet, so the same 24 words
// open the same coins everywhere. Nothing secret is ever sent anywhere.
import * as Q from "./quant.js";

const KEY = "quant.wallet.v1";
const HIST = "quant.history.v1";
const SESSION = "quant.session.v1";
export const SCAN = 10; // addresses checked for coins (the desktop wallet hands out new ones)

const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const store = {
  get(k, s = localStorage) { try { return s.getItem(k); } catch { return null; } },
  set(k, v, s = localStorage) { try { s.setItem(k, v); } catch {} },
  del(k, s = localStorage) { try { s.removeItem(k); } catch {} },
};

async function aesKey(password, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export const hasWallet = () => !!store.get(KEY);

export async function saveNew(words, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(password, salt),
    new TextEncoder().encode(JSON.stringify({ words: Q.normalizeWords(words) }))));
  store.set(KEY, JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
}

async function decrypt(password) {
  const w = JSON.parse(store.get(KEY));
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(w.iv) }, await aesKey(password, unb64(w.salt)), unb64(w.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch { throw new Error("Wrong password"); }
}

export function forget() { store.del(KEY); store.del(HIST); store.del(SESSION, sessionStorage); }

// ---------------------------------------------------------------- unlocked wallet
export class Wallet {
  constructor(master, hrp) {
    this.master = master;
    this.hrp = hrp;
    this.keys = new Map();   // hex(addrHash) -> {pk, sk, index}
    this.addrs = [];         // [{index, hash, str}]
    for (let i = 0; i < SCAN; i++) {
      const kp = Q.keypair(master, i);
      const h = Q.addressHash(kp.pk);
      this.keys.set(Q.hex(h), { ...kp, index: i });
      this.addrs.push({ index: i, hash: h, str: Q.encodeAddress(hrp, h) });
    }
    this.coins = [];
  }
  get receive() { return this.addrs[0]; }
  static async unlock(password, hrp, remember) {
    const { words } = await decrypt(password);
    const master = Q.masterKey(words);
    if (remember) store.set(SESSION, Q.hex(master), sessionStorage);
    return new Wallet(master, hrp);
  }
  static fromSession(hrp) {
    const m = store.get(SESSION, sessionStorage);
    return m ? new Wallet(Q.unhex(m), hrp) : null;
  }
  static async revealWords(password) { return (await decrypt(password)).words; }
  lock() { store.del(SESSION, sessionStorage); }

  async refresh(api) {
    const all = [];
    let genesis = null, tip = 0;
    for (const a of this.addrs) {
      const r = await api.call("getaddresscoins", [a.str]);
      genesis = r.genesis; tip = r.tip;
      for (const c of r.coins) all.push({ ...Q.coinsFromApi([c], a.hash)[0], label: c.asset, amount: c.amount });
    }
    this.coins = all;
    this.genesis = Q.unhex(genesis);
    this.tip = tip;
    return this;
  }
  // { "<asset hex or ''>": {units, label, pending} }
  balances() {
    const m = new Map();
    for (const c of this.coins) {
      const k = c.asset ? Q.hex(c.asset) : "";
      const e = m.get(k) || { units: 0n, pending: 0n, immature: 0n, label: c.label };
      if (c.height < 0) e.pending += c.value;
      else if (c.mature === false) e.immature += c.value;
      else e.units += c.value;
      m.set(k, e);
    }
    return m;
  }
  build(plan, feePerKb) {
    return Q.buildTx({ plan, coins: this.coins, keys: this.keys, changeAddr: this.receive.hash, genesis: this.genesis, feePerKb });
  }
}

// ---------------------------------------------------------------- local activity (this browser)
export function history() { try { return JSON.parse(store.get(HIST) || "[]"); } catch { return []; } }
export function record(entry) {
  const h = history();
  h.unshift({ time: Date.now(), ...entry });
  store.set(HIST, JSON.stringify(h.slice(0, 200)));
}
