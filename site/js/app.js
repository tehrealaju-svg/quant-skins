// Quant Skins: CS2 skins for QNT. Supabase holds listings/orders; payments are real Quant
// transactions signed in the browser with the same wallet as the Quant site.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import * as Q from "./shared/quant.js";
import { Wallet, hasWallet } from "./shared/wallet.js";
import { SUPABASE_URL, SUPABASE_KEY, NETWORK, QUANT_SITE } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const FN = `${SUPABASE_URL}/functions/v1`;
const HRP = Q.HRP[NETWORK];
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const view = $("#view");
let me = null, settings = null, wallet = null;
const cart = { shop: new Map(), mine: new Map() }; // id -> item

// ---------------------------------------------------------------- helpers
function toast(msg, ms = 3500) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}
function modal(html) {
  const bg = document.createElement("div"); bg.className = "modal-bg"; bg.innerHTML = `<div class="modal">${html}</div>`;
  bg.addEventListener("click", (e) => { if (e.target === bg) bg.remove(); });
  document.body.appendChild(bg); return bg;
}
const busy = (b, on, l = "") => { b.disabled = on; if (on) { b.dataset.l = b.innerHTML; b.innerHTML = `<span class="spinner"></span>${l}`; } else if (b.dataset.l) b.innerHTML = b.dataset.l; };
const qnt = (v) => (v === null || v === undefined ? "–" : (+v).toLocaleString(undefined, { maximumFractionDigits: 4 }));
const usd = (v) => (v === null || v === undefined ? "" : "$" + (+v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const WEARNAME = { FN: "Factory New", MW: "Minimal Wear", FT: "Field-Tested", WW: "Well-Worn", BS: "Battle-Scarred" };
const STATUS = {
  awaiting_payment: "Waiting for your payment", awaiting_skins: "Send your skins", paid: "Paid — trade coming",
  trade_sent: "Trade offer sent", done: "Done", cancelled: "Cancelled",
};
async function fn(name, body, qs = "") {
  const { data: s } = await sb.auth.getSession();
  const r = await fetch(`${FN}/${name}${qs}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${s.session?.access_token || SUPABASE_KEY}`, apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({ error: "Bad response" }));
  if (j.error) throw new Error(j.error);
  return j;
}
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

function floatBar(f) {
  if (f === null || f === undefined || f === "") return "";
  const pct = Math.min(100, Math.max(0, +f * 100));
  return `<div class="fwrap"><div class="fbar"><i class="fn"></i><i class="mw"></i><i class="ft"></i><i class="ww"></i><i class="bs"></i></div>
    <span class="mk" style="left:calc(${pct}% - 1px)"></span></div><div class="wr">Float ${(+f).toFixed(6)}</div>`;
}
function skinCard(s, { selected, off, price } = {}) {
  return `<div class="skin ${selected ? "sel" : ""} ${off ? "off" : ""}" data-k="${esc(s.id ?? s.asset_id)}" style="--rarity:${esc(s.rarity_color || "")}">
    <img src="${esc(s.image)}" alt="" loading="lazy">
    <div class="nm">${esc(s.item || s.name)}</div>
    <div class="wr">${esc(WEARNAME[s.wear] || "")}</div>
    ${floatBar(s.float_value ?? s.float)}
    <div class="pr">${price ?? (s.qnt === null ? `<span class="faint">No price yet</span>` : `${qnt(s.qnt)} QNT <small>${usd(s.usd)}</small>`)}</div>
  </div>`;
}

// ---------------------------------------------------------------- session
async function loadMe() {
  const { data } = await sb.auth.getSession();
  me = null;
  if (data.session) {
    const { data: p } = await sb.from("skin_profiles").select("*").eq("id", data.session.user.id).maybeSingle();
    me = p;
  }
  settings = must(await sb.from("skin_settings").select("*").single());
  $("#nav-admin").classList.toggle("hidden", !me?.is_admin);
  $("#who").innerHTML = me
    ? `<a href="#/account" class="row" style="color:inherit"><img class="avatar" src="${esc(me.avatar)}" alt=""><span class="net-label">${esc(me.name || "Account")}</span></a>`
    : `<a class="btn sm steam-btn" href="${FN}/steam-login?start=1">Sign in with Steam</a>`;
}
const needLogin = () => {
  if (me) return true;
  view.innerHTML = `<div class="card stack" style="max-width:440px;margin:40px auto;text-align:center">
    <h1>Sign in</h1><p class="muted">Use your Steam account. You can scan the QR code with the Steam app; we never see your password.</p>
    <a class="btn steam-btn block" href="${FN}/steam-login?start=1">Sign in with Steam</a></div>`;
  return false;
};

// ---------------------------------------------------------------- router
const routes = { "": market, trade, orders, order: orderView, account, admin, auth, "login-failed": loginFailed };
async function route() {
  const [name, arg] = location.hash.replace(/^#\/?/, "").split("/");
  $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === (name || "home")));
  view.innerHTML = `<div class="row muted"><span class="spinner"></span>Loading…</div>`;
  try { await (routes[name] || market)(arg && decodeURIComponent(arg)); }
  catch (e) { view.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
}
window.addEventListener("hashchange", route);

async function auth(tokenHash) {
  const { error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
  if (error) throw new Error("Sign-in link expired, please try again");
  await loadMe();
  toast(`Signed in as ${me?.name || "you"}`);
  location.hash = me && !me.trade_url ? "#/account" : "#/";
}
function loginFailed() { view.innerHTML = `<div class="notice err">Steam sign-in didn't complete. <a href="${FN}/steam-login?start=1">Try again</a></div>`; }

// ---------------------------------------------------------------- market
async function market() {
  const items = must(await sb.from("skin_market").select("*").eq("status", "available").order("usd", { ascending: false }));
  view.innerHTML = `
  <div class="page-head"><div><h1>CS2 skins for QNT</h1><span class="muted">${items.length} skins · 1 QNT = ${usd(settings.usd_per_qnt)} · lower float costs more</span></div>
    <a class="btn" href="#/trade">Trade your skins</a></div>
  <div class="filters"><input class="in" id="q" placeholder="Search skins"><select class="in" id="w"><option value="">All wears</option>${Object.entries(WEARNAME).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
    <select class="in" id="s"><option value="hi">Price: high to low</option><option value="lo">Price: low to high</option><option value="fl">Float: lowest</option><option value="new">Newest</option></select></div>
  <div class="skins" id="grid"></div>`;
  const draw = () => {
    const q = $("#q").value.toLowerCase(), w = $("#w").value, s = $("#s").value;
    let list = items.filter((i) => (!q || i.name.toLowerCase().includes(q)) && (!w || i.wear === w));
    list.sort((a, b) => s === "lo" ? a.usd - b.usd : s === "fl" ? (a.float_value ?? 9) - (b.float_value ?? 9) : s === "new" ? b.listed_at.localeCompare(a.listed_at) : b.usd - a.usd);
    $("#grid").innerHTML = list.map((i) => skinCard(i, { selected: cart.shop.has(String(i.id)) })).join("") || `<p class="muted">No skins listed yet.</p>`;
    $$("#grid .skin").forEach((el) => (el.onclick = () => {
      const it = items.find((i) => String(i.id) === el.dataset.k);
      if (cart.shop.has(el.dataset.k)) cart.shop.delete(el.dataset.k); else cart.shop.set(el.dataset.k, it);
      el.classList.toggle("sel");
      toast(cart.shop.size ? `${cart.shop.size} selected — open Trade to check out` : "Removed", 1600);
    }));
  };
  $$("#q,#w,#s").forEach((e) => (e.oninput = draw)); draw();
}

// ---------------------------------------------------------------- trade (buy / sell / swap)
async function trade() {
  if (!needLogin()) return;
  const shop = must(await sb.from("skin_market").select("*").eq("status", "available").order("usd", { ascending: false }));
  view.innerHTML = `<div class="trade">
    <div class="card pane"><div class="row between"><h2 style="margin:0">Your skins</h2><span class="faint" style="font-size:13px">we pay ${Math.round(settings.sell_ratio * 100)}%</span></div>
      <input class="in" id="qm" placeholder="Search" style="margin:12px 0"><div id="mine"><div class="row muted"><span class="spinner"></span>Loading your Steam inventory…</div></div></div>
    <div class="card summary stack" id="sum"></div>
    <div class="card pane"><h2>Shop</h2><input class="in" id="qs" placeholder="Search" style="margin-bottom:12px"><div id="shop"></div></div>
  </div>`;
  let mine = [];
  const drawSum = () => {
    const give = [...cart.mine.values()].reduce((a, i) => a + (i.qnt || 0), 0);
    const get = [...cart.shop.values()].reduce((a, i) => a + (+i.qnt || 0), 0);
    const diff = get - give;
    $("#sum").innerHTML = `<h2 style="margin:0">Summary</h2>
      <dl class="kv"><dt>You give</dt><dd>${cart.mine.size} skins · ${qnt(give)} QNT</dd><dt>You get</dt><dd>${cart.shop.size} skins · ${qnt(get)} QNT</dd></dl>
      <div><span class="muted">${diff > 0 ? "You pay" : diff < 0 ? "You receive" : "Even trade"}</span>
        <div class="big-total">${qnt(Math.abs(diff))} QNT</div><span class="faint">${usd(Math.abs(diff) * settings.usd_per_qnt)}</span></div>
      <button class="btn block" id="place" ${cart.mine.size + cart.shop.size ? "" : "disabled"}>${cart.shop.size && cart.mine.size ? "Swap" : cart.mine.size ? "Sell" : "Buy"}</button>
      ${!me.trade_url ? `<div class="notice warn">Add your Steam trade URL in <a href="#/account">Account</a> first.</div>` : ""}
      ${diff < 0 && !me.qnt_address ? `<div class="notice warn">Add your QNT address in <a href="#/account">Account</a> so we can pay you.</div>` : ""}`;
    $("#place").onclick = place;
  };
  const drawShop = () => {
    const q = $("#qs").value.toLowerCase();
    $("#shop").innerHTML = `<div class="skins">${shop.filter((i) => !q || i.name.toLowerCase().includes(q)).map((i) => skinCard(i, { selected: cart.shop.has(String(i.id)) })).join("")}</div>`;
    $$("#shop .skin").forEach((el) => (el.onclick = () => {
      const k = el.dataset.k; cart.shop.has(k) ? cart.shop.delete(k) : cart.shop.set(k, shop.find((i) => String(i.id) === k));
      el.classList.toggle("sel"); drawSum();
    }));
  };
  const drawMine = () => {
    const q = $("#qm").value.toLowerCase();
    $("#mine").innerHTML = mine.length ? `<div class="skins">${mine.filter((i) => !q || i.name.toLowerCase().includes(q)).map((i) =>
      skinCard(i, { selected: cart.mine.has(i.asset_id), off: i.qnt === null })).join("")}</div>` : `<p class="muted">No tradable CS2 skins found.</p>`;
    $$("#mine .skin:not(.off)").forEach((el) => (el.onclick = () => {
      const k = el.dataset.k; cart.mine.has(k) ? cart.mine.delete(k) : cart.mine.set(k, mine.find((i) => i.asset_id === k));
      el.classList.toggle("sel"); drawSum();
    }));
  };
  const place = async (e) => {
    const b = e.target;
    try {
      busy(b, true, "Placing…");
      const userItems = [...cart.mine.values()].map((i) => ({ asset_id: i.asset_id, name: i.name, item: i.item, wear: i.wear, float: i.float, image: i.image }));
      const o = must(await sb.rpc("skin_place_order", { p_shop_ids: [...cart.shop.keys()].map(Number), p_user_items: userItems }));
      cart.shop.clear(); cart.mine.clear();
      location.hash = "#/order/" + o.id;
    } catch (err) { busy(b, false); toast(err.message, 5000); }
  };
  $("#qs").oninput = drawShop; $("#qm").oninput = drawMine;
  drawShop(); drawSum();
  try { mine = (await fn("inventory")).items; } catch (e) { $("#mine").innerHTML = `<div class="notice err">${esc(e.message)}</div>`; return; }
  drawMine();
}

// ---------------------------------------------------------------- orders
async function orders() {
  if (!needLogin()) return;
  const list = must(await sb.from("skin_orders").select("*").eq("user_id", me.id).order("created_at", { ascending: false }));
  view.innerHTML = `<h1>My orders</h1><div class="card"><ul class="list">${list.map((o) => `<li style="cursor:pointer" onclick="location.hash='#/order/${o.id}'">
    <div class="grow"><b>#${o.id} · ${o.kind}</b><div class="thumbs" style="margin-top:6px">${[...o.shop_items, ...o.user_items].slice(0, 6).map((i) => `<img src="${esc(i.image)}" alt="">`).join("")}</div></div>
    <div class="r"><span class="status ${o.status}">${STATUS[o.status]}</span><div class="faint" style="font-size:13px;margin-top:4px">${qnt(Math.abs(o.qnt_due))} QNT ${o.qnt_due > 0 ? "to pay" : o.qnt_due < 0 ? "to receive" : ""}</div></div></li>`).join("") || `<li class="muted">No orders yet.</li>`}</ul></div>`;
}

async function orderView(id) {
  if (!needLogin()) return;
  const o = must(await sb.from("skin_orders").select("*").eq("id", id).single());
  const list = (items, label) => items.length ? `<h3>${label}</h3><ul class="list">${items.map((i) => `<li><img src="${esc(i.image)}" alt="" style="width:64px;height:48px;object-fit:contain">
    <div class="grow"><b>${esc(i.name)}</b>${i.float ? `<div class="faint">Float ${(+i.float).toFixed(6)}</div>` : ""}</div><div class="r">${qnt(i.qnt)} QNT</div></li>`).join("")}</ul>` : "";
  view.innerHTML = `<div style="max-width:720px" class="stack">
    <div class="row between wrap"><h1>Order #${o.id}</h1><span class="status ${o.status}">${STATUS[o.status]}</span></div>
    <div class="card">${list(o.shop_items, "You get")}${list(o.user_items, "You give")}
      <div class="row between" style="margin-top:12px"><span class="muted">${o.qnt_due > 0 ? "You pay" : o.qnt_due < 0 ? "You receive" : "Even trade"}</span><span class="big-total">${qnt(Math.abs(o.qnt_due))} QNT</span></div></div>
    <div class="card stack" id="next"></div></div>`;
  const next = $("#next");
  if (o.status === "awaiting_payment") {
    next.innerHTML = `<h2>Pay ${qnt(o.qnt_due)} QNT</h2>
      <p class="muted" style="margin:0">Pay from your Quant wallet in one tap, or send exactly this amount from any Quant wallet and paste the transaction ID. Unpaid orders are cancelled after 30 minutes.</p>
      <button class="btn block" id="pay">Pay with my Quant wallet</button>
      <div><label class="f">Shop address</label><div class="mono">${esc(settings.shop_address)}</div></div>
      <div class="row"><input class="in mono" id="tx" placeholder="Transaction ID (if you paid elsewhere)"><button class="btn ghost" id="chk">Check</button></div>
      <button class="btn line sm" id="cancel">Cancel order</button>`;
    $("#pay").onclick = (e) => payWithWallet(o, e.target);
    $("#chk").onclick = (e) => checkPayment(o, $("#tx").value.trim(), e.target);
    $("#cancel").onclick = async () => { try { must(await sb.rpc("skin_cancel_order", { p_id: o.id })); route(); } catch (e) { toast(e.message); } };
    if (o.pay_txid) checkPayment(o, o.pay_txid, null, true);
  } else if (o.status === "awaiting_skins") {
    next.innerHTML = `<h2>Send your skins</h2>
      <p class="muted" style="margin:0">Open a Steam trade offer to our account and add exactly the skins above. Once we accept it we ${o.qnt_due < 0 ? `send ${qnt(-o.qnt_due)} QNT to your address` : "send your new skins"}.</p>
      <a class="btn block" href="${esc(settings.bot_trade_url)}" target="_blank" rel="noopener">Open Steam trade offer</a>
      <p class="faint" style="font-size:13px;margin:0">Only trust trade offers with the order number #${o.id} in the message.</p>
      <button class="btn line sm" id="cancel">Cancel order</button>`;
    $("#cancel").onclick = async () => { try { must(await sb.rpc("skin_cancel_order", { p_id: o.id })); route(); } catch (e) { toast(e.message); } };
  } else if (o.status === "paid") {
    next.innerHTML = `<h2>Payment received ✓</h2><p class="muted" style="margin:0">We'll send a Steam trade offer to your trade URL soon${o.user_items.length ? ", asking for your skins at the same time" : ""}. It will mention order #${o.id}.</p>`;
  } else if (o.status === "trade_sent") {
    next.innerHTML = `<h2>Check Steam</h2><p class="muted" style="margin:0">A trade offer for order #${o.id} is waiting in Steam. Accept it in the Steam app.</p>
      <a class="btn block" href="https://steamcommunity.com/my/tradeoffers" target="_blank" rel="noopener">Open my trade offers</a>`;
  } else if (o.status === "done") {
    next.innerHTML = `<h2>All done ✓</h2>${o.payout_txid ? `<p class="muted">We paid you: <span class="mono">${esc(o.payout_txid)}</span></p>` : ""}`;
  } else next.innerHTML = `<p class="muted">${esc(o.note || "This order was cancelled.")}</p>`;
  // Live status updates.
  const ch = sb.channel("o" + o.id).on("postgres_changes", { event: "UPDATE", schema: "public", table: "skin_orders", filter: `id=eq.${o.id}` },
    () => { sb.removeChannel(ch); if (location.hash === "#/order/" + o.id) route(); }).subscribe();
}

async function nodeApi() {
  const { data } = await sb.from("quant_node").select("url").eq("network", NETWORK).maybeSingle();
  if (!data?.url) throw new Error("The Quant network is offline right now");
  return new Q.NodeApi(data.url);
}
async function getWallet() {
  if (wallet) return wallet;
  if (!hasWallet()) throw new Error(`No Quant wallet in this browser yet. Create one on the Quant site first: ${QUANT_SITE}`);
  wallet = Wallet.fromSession(HRP);
  if (wallet) return wallet;
  return new Promise((resolve, reject) => {
    const m = modal(`<h2>Unlock your Quant wallet</h2><input class="in" type="password" id="pw" placeholder="Wallet password">
      <div class="row" style="margin-top:12px"><button class="btn" id="go">Unlock</button><button class="btn ghost" id="no">Cancel</button></div>`);
    $("#no", m).onclick = () => { m.remove(); reject(new Error("Cancelled")); };
    $("#go", m).onclick = async (e) => {
      try { busy(e.target, true); wallet = await Wallet.unlock($("#pw", m).value, HRP, true); m.remove(); resolve(wallet); }
      catch (err) { busy(e.target, false); toast(err.message); }
    };
  });
}
async function payWithWallet(o, btn) {
  try {
    const api = await nodeApi();
    const w = await getWallet();
    busy(btn, true, "Preparing…");
    await w.refresh(api);
    const to = Q.decodeAddress(HRP, settings.shop_address);
    if (!to) throw new Error("The shop address isn't set up yet");
    const b = w.build({ outs: [{ value: Q.parseUnits(String(o.qnt_due)), asset: null, addr: to }], ops: [] });
    busy(btn, false);
    const m = modal(`<h2>Confirm payment</h2><p>Pay ${qnt(o.qnt_due)} QNT for order #${o.id}</p><dl class="kv"><dt>Network fee</dt><dd>${Q.formatUnits(b.fee)} QNT</dd></dl>
      <div class="row" style="margin-top:14px"><button class="btn" id="ok">Pay</button><button class="btn ghost" id="no">Cancel</button></div>`);
    $("#no", m).onclick = () => m.remove();
    $("#ok", m).onclick = async (e) => {
      try {
        busy(e.target, true, "Sending…");
        const id = await api.call("sendrawtransaction", [b.hex]);
        m.remove();
        toast("Payment sent ✓ — confirming (~2 min)");
        checkPayment(o, id, null, true);
      } catch (err) { busy(e.target, false); toast(err.message, 5000); }
    };
  } catch (e) { busy(btn, false); toast(e.message, 5000); }
}
async function checkPayment(o, txid, btn, poll) {
  if (!/^[0-9a-f]{64}$/.test(txid)) { toast("Paste a 64-character transaction ID"); return; }
  try {
    if (btn) busy(btn, true);
    const r = await fn("verify-payment", { order_id: o.id, txid });
    if (btn) busy(btn, false);
    if (r.status === "paid") { toast("Payment confirmed ✓"); route(); return; }
    if (r.note && !poll) toast(r.note);
    if (poll && location.hash === "#/order/" + o.id) {
      const n = $("#next");
      if (n && !$("#waitnote", n)) n.insertAdjacentHTML("afterbegin", `<div class="notice" id="waitnote"><span class="spinner" style="display:inline-block;vertical-align:middle;margin-right:8px"></span>${esc(r.note || "Waiting for confirmation…")}</div>`);
      setTimeout(() => checkPayment(o, txid, null, true), 30000);
    }
  } catch (e) { if (btn) busy(btn, false); toast(e.message, 5000); }
}

// ---------------------------------------------------------------- account
async function account() {
  if (!needLogin()) return;
  view.innerHTML = `<div style="max-width:560px" class="stack"><div class="row"><img class="avatar" style="width:56px;height:56px" src="${esc(me.avatar)}" alt=""><div><h1 style="margin:0">${esc(me.name)}</h1><span class="faint mono">${esc(me.steam_id)}</span></div></div>
    <div class="card stack">
      <div><label class="f">Steam trade URL</label><input class="in mono" id="tu" value="${esc(me.trade_url)}" placeholder="https://steamcommunity.com/tradeoffer/new/?partner=…&token=…">
        <a href="https://steamcommunity.com/my/tradeoffers/privacy#trade_offer_access_url" target="_blank" rel="noopener" style="font-size:13px">Find my trade URL</a></div>
      <div><label class="f">QNT address (where we pay you when you sell)</label><input class="in mono" id="qa" value="${esc(me.qnt_address)}" placeholder="${HRP}1…">
        <button class="btn ghost sm" id="mine" style="margin-top:6px">Use my Quant wallet address</button></div>
      <button class="btn" id="sv">Save</button></div>
    <button class="btn line" id="out">Sign out</button></div>`;
  $("#mine").onclick = async () => { try { $("#qa").value = (await getWallet()).receive.str; } catch (e) { toast(e.message); } };
  $("#sv").onclick = async () => {
    try {
      const tu = $("#tu").value.trim(), qa = $("#qa").value.trim();
      if (tu && !/^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[A-Za-z0-9_-]+$/.test(tu)) throw new Error("That doesn't look like a Steam trade URL");
      if (qa && !Q.decodeAddress(HRP, qa)) throw new Error("That isn't a valid QNT address");
      must(await sb.from("skin_profiles").update({ trade_url: tu, qnt_address: qa }).eq("id", me.id));
      await loadMe(); toast("Saved");
    } catch (e) { toast(e.message); }
  };
  $("#out").onclick = async () => { await sb.auth.signOut(); await loadMe(); location.hash = "#/"; };
}

// ---------------------------------------------------------------- admin
let adminCh = null;
function beep() {
  try {
    const a = new AudioContext(), o = a.createOscillator(), g = a.createGain();
    o.frequency.value = 880; g.gain.value = .15; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + .25);
  } catch {}
}
function alertAdmin(text) {
  beep();
  document.title = "(!) Quant Skins";
  if ("Notification" in window && Notification.permission === "granted") new Notification("Quant Skins", { body: text, icon: "img/icon.svg" });
}
async function admin(tab = "orders") {
  if (!needLogin()) return;
  if (!me.is_admin) throw new Error("Admins only");
  document.title = "Quant Skins";
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  if (!adminCh) adminCh = sb.channel("admin").on("postgres_changes", { event: "*", schema: "public", table: "skin_orders" }, (p) => {
    if (p.eventType === "INSERT") alertAdmin(`New ${p.new.kind} order #${p.new.id}`);
    else if (p.new.status === "paid" && p.old?.status !== "paid") alertAdmin(`Order #${p.new.id} paid`);
    if (location.hash.startsWith("#/admin")) route();
  }).subscribe();
  view.innerHTML = `<div class="page-head"><h1>Admin</h1><div class="seg" id="tabs"><button data-t="orders">Orders</button><button data-t="list">List skins</button><button data-t="settings">Settings</button></div></div><div id="pane"></div>`;
  $$("#tabs button").forEach((b) => { b.classList.toggle("on", b.dataset.t === tab); b.onclick = () => (location.hash = "#/admin/" + b.dataset.t); });
  await ({ orders: adminOrders, list: adminList, settings: adminSettings }[tab] || adminOrders)($("#pane"));
}
async function adminOrders(el) {
  await sb.rpc("skin_expire_orders"); // Supabase builders are thenables without .catch; errors come back in the result
  const list = must(await sb.from("skin_orders").select("*, skin_profiles(name, steam_id, trade_url, qnt_address)").not("status", "in", "(done,cancelled)").order("created_at"));
  el.innerHTML = `<p class="muted">${list.length} open orders. This page beeps and notifies you when an order arrives or gets paid — keep it open.</p>` +
    list.map((o) => `<div class="card stack" style="margin-bottom:12px"><div class="row between wrap"><b>#${o.id} · ${o.kind} · ${esc(o.skin_profiles?.name)}</b><span class="status ${o.status}">${STATUS[o.status]}</span></div>
      ${o.shop_items.length ? `<div><span class="muted">Send them:</span> ${o.shop_items.map((i) => esc(i.name) + (i.float ? ` (${(+i.float).toFixed(4)})` : "")).join(", ")}</div>` : ""}
      ${o.user_items.length ? `<div><span class="muted">Receive from them:</span> ${o.user_items.map((i) => esc(i.name)).join(", ")}</div>` : ""}
      <div>${o.qnt_due > 0 ? `They pay <b>${qnt(o.qnt_due)} QNT</b>${o.pay_txid ? ` · tx <span class="mono">${esc(o.pay_txid.slice(0, 16))}…</span>` : ""}` : o.qnt_due < 0 ? `You pay them <b>${qnt(-o.qnt_due)} QNT</b> → <span class="mono">${esc(o.skin_profiles?.qnt_address || "no address set")}</span>` : "Even swap"}</div>
      <div class="row wrap">
        <a class="btn sm" href="${esc(o.skin_profiles?.trade_url)}" target="_blank" rel="noopener">Open trade with them</a>
        ${["paid", "awaiting_skins"].includes(o.status) ? `<button class="btn ghost sm" data-a="sent" data-id="${o.id}">Mark trade sent</button>` : ""}
        ${o.qnt_due < 0 && !o.payout_txid ? `<button class="btn ghost sm" data-a="payout" data-id="${o.id}">Pay ${qnt(-o.qnt_due)} QNT</button>` : ""}
        <button class="btn ghost sm" data-a="done" data-id="${o.id}">Mark done</button>
        <button class="btn line sm" data-a="cancel" data-id="${o.id}">Cancel</button></div>
      <p class="faint" style="margin:0;font-size:13px">Put “Order #${o.id}” in the Steam trade message.</p></div>`).join("");
  $$("[data-a]", el).forEach((b) => (b.onclick = async () => {
    const o = list.find((x) => String(x.id) === b.dataset.id);
    try {
      if (b.dataset.a === "sent") must(await sb.from("skin_orders").update({ status: "trade_sent", updated_at: new Date().toISOString() }).eq("id", o.id));
      if (b.dataset.a === "cancel") must(await sb.rpc("skin_cancel_order", { p_id: o.id }));
      if (b.dataset.a === "done") {
        must(await sb.from("skin_orders").update({ status: "done", updated_at: new Date().toISOString() }).eq("id", o.id));
        const ids = o.shop_items.map((i) => i.id);
        if (ids.length) must(await sb.from("skin_items").update({ status: "sold" }).in("id", ids));
      }
      if (b.dataset.a === "payout") {
        const to = Q.decodeAddress(HRP, o.skin_profiles?.qnt_address || "");
        if (!to) throw new Error("They haven't set a valid QNT address");
        const api = await nodeApi(), w = await getWallet();
        await w.refresh(api);
        const built = w.build({ outs: [{ value: Q.parseUnits(String(-o.qnt_due)), asset: null, addr: to }], ops: [] });
        if (!confirm(`Pay ${qnt(-o.qnt_due)} QNT (+${Q.formatUnits(built.fee)} fee) to ${o.skin_profiles.name}?`)) return;
        const id = await api.call("sendrawtransaction", [built.hex]);
        must(await sb.from("skin_orders").update({ payout_txid: id, updated_at: new Date().toISOString() }).eq("id", o.id));
        toast("Paid ✓");
      }
      route();
    } catch (e) { toast(e.message, 5000); }
  }));
}
async function adminList(el) {
  el.innerHTML = `<div class="row muted"><span class="spinner"></span>Loading the shop account's Steam inventory…</div>`;
  const inv = await fn("inventory", null, "?bot=1");
  el.innerHTML = `<p class="muted">Set the float (from the in-game inspect or CSFloat), then list. Price = csgoskins.gg price for that wear + up to ${Math.round(settings.float_premium * 100)}% for a low float.</p>
    <div class="skins">${inv.items.map((i) => `<div class="skin ${i.listed ? "off" : ""}" style="--rarity:${esc(i.rarity_color)};cursor:default">
      <img src="${esc(i.image)}" alt=""><div class="nm">${esc(i.name)}</div>
      <div class="wr">${i.usd ? usd(i.usd) + " base" : "no price"}</div>
      ${i.listed ? `<span class="pill">Listed</span>` : `<input class="in" placeholder="Float e.g. 0.1834" data-f="${i.asset_id}" inputmode="decimal">
        ${i.inspect_link ? `<a href="${esc(i.inspect_link)}" style="font-size:12px">Inspect in CS2</a>` : ""}
        <button class="btn sm" data-l="${i.asset_id}">List</button>`}</div>`).join("")}</div>`;
  $$("[data-l]", el).forEach((b) => (b.onclick = async () => {
    const i = inv.items.find((x) => x.asset_id === b.dataset.l);
    const f = $(`[data-f="${i.asset_id}"]`, el).value.trim();
    try {
      if (f && !(+f >= 0 && +f <= 1)) throw new Error("Float must be between 0 and 1");
      must(await sb.from("skin_items").insert({ asset_id: i.asset_id, name: i.name, item: i.item, wear: i.wear, float_value: f ? +f : null,
        image: i.image, rarity_color: i.rarity_color, inspect_link: i.inspect_link }));
      toast("Listed ✓"); b.closest(".skin").classList.add("off"); b.replaceWith(Object.assign(document.createElement("span"), { className: "pill", textContent: "Listed" }));
    } catch (e) { toast(e.message); }
  }));
}
async function adminSettings(el) {
  const s = settings;
  el.innerHTML = `<div class="card stack" style="max-width:600px">
    <div><label class="f">USD per 1 QNT</label><input class="in" id="r" value="${s.usd_per_qnt}"></div>
    <div><label class="f">Low-float premium (0.30 = best float in a wear costs up to 30% more)</label><input class="in" id="p" value="${s.float_premium}"></div>
    <div><label class="f">We pay users (0.90 = 90% of price)</label><input class="in" id="sr" value="${s.sell_ratio}"></div>
    <div><label class="f">Shop QNT address (buyers pay here)</label><input class="in mono" id="sa" value="${esc(s.shop_address)}">
      <button class="btn ghost sm" id="mine" style="margin-top:6px">Use my Quant wallet address</button></div>
    <div><label class="f">Shop Steam trade URL</label><input class="in mono" id="bt" value="${esc(s.bot_trade_url)}"></div>
    <div><label class="f">Shop Steam ID (17 digits)</label><input class="in mono" id="bs" value="${esc(s.bot_steam_id)}"></div>
    <div class="row"><button class="btn" id="sv">Save</button><button class="btn ghost" id="rp">Refresh all prices</button></div></div>`;
  $("#mine").onclick = async () => { try { $("#sa").value = (await getWallet()).receive.str; } catch (e) { toast(e.message); } };
  $("#sv").onclick = async () => {
    try {
      if ($("#sa").value && !Q.decodeAddress(HRP, $("#sa").value.trim())) throw new Error("Invalid shop QNT address");
      must(await sb.from("skin_settings").update({ usd_per_qnt: +$("#r").value, float_premium: +$("#p").value, sell_ratio: +$("#sr").value,
        shop_address: $("#sa").value.trim(), bot_trade_url: $("#bt").value.trim(), bot_steam_id: $("#bs").value.trim(), updated_at: new Date().toISOString() }).eq("id", 1));
      await loadMe(); toast("Saved");
    } catch (e) { toast(e.message); }
  };
  $("#rp").onclick = async (e) => { try { busy(e.target, true, "Fetching…"); const r = await fn("prices", {}); busy(e.target, false); toast(`Updated ${Object.keys(r.results).length} skins`); } catch (err) { busy(e.target, false); toast(err.message); } };
}

// ---------------------------------------------------------------- start
(async () => {
  view.innerHTML = `<div class="row muted"><span class="spinner"></span>Loading…</div>`;
  if (!SUPABASE_KEY) { view.innerHTML = `<div class="notice warn">Setup isn't finished: add the Supabase publishable key to js/config.js.</div>`; return; }
  await Q.loadCrypto(new URL("../qcrypto.wasm", import.meta.url));
  await loadMe();
  route();
})();
