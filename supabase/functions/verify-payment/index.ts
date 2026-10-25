// Checks a QNT payment for an order on the Quant network (via the node the sites use) and marks
// the order paid once the transaction pays the shop address enough and has a confirmation.
// Body: { order_id, txid }
import { admin, caller, cors, json } from "../_shared/common.ts";

const COIN = 10_000_000_000n;
const toUnits = (q: string | number) => {
  const [i, f = ""] = String(q).split(".");
  return BigInt(i) * COIN + BigInt((f + "0000000000").slice(0, 10));
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const me = await caller(req);
    if (!me) return json({ error: "Sign in first" }, 401);
    const { order_id, txid } = await req.json();
    if (!/^[0-9a-f]{64}$/.test(txid || "")) return json({ error: "Bad transaction id" }, 400);
    const db = admin();
    const { data: o } = await db.from("skin_orders").select("*").eq("id", order_id).single();
    if (!o || (o.user_id !== me.id && !me.is_admin)) return json({ error: "Order not found" }, 404);
    if (!["awaiting_payment", "paid"].includes(o.status)) return json({ status: o.status });
    const { data: dup } = await db.from("skin_orders").select("id").eq("pay_txid", txid).neq("id", o.id).maybeSingle();
    if (dup) return json({ error: "That payment is already used by another order" }, 400);
    if (!o.pay_txid) await db.from("skin_orders").update({ pay_txid: txid, updated_at: new Date().toISOString() }).eq("id", o.id);

    const { data: s } = await db.from("skin_settings").select("shop_address").single();
    const { data: node } = await db.from("quant_node").select("url").eq("network", Deno.env.get("QUANT_NETWORK") || "test").single();
    if (!node?.url) return json({ status: "awaiting_payment", note: "Quant network unreachable; will retry" });
    const r = await fetch(node.url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "gettransaction", params: [txid], id: 1 }) });
    const j = await r.json();
    if (j.error) return json({ status: "awaiting_payment", note: "Payment not seen yet" });
    const tx = j.result;
    let paid = 0n;
    for (const out of tx.outputs) if (out.address === s.shop_address && out.asset === "QNT") paid += BigInt(out.units);
    if (paid < toUnits(o.qnt_due)) return json({ error: "That payment is less than the order total" }, 400);
    if ((tx.confirmations || 0) < 1) return json({ status: "awaiting_payment", note: "Payment seen, waiting for 1 confirmation (~2 min)" });
    await db.from("skin_orders").update({ status: "paid", updated_at: new Date().toISOString() }).eq("id", o.id).eq("status", "awaiting_payment");
    return json({ status: "paid" });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
