// Sign in through Steam (OpenID 2.0). Steam's page offers the QR code for the Steam app.
//   GET ?start=1            -> redirect to Steam
//   GET (Steam's callback)  -> verify with Steam, create/update the user, redirect back to the
//                              site with a one-time login token the site exchanges for a session.
// Env: SITE_URL (where to send people back), ADMIN_STEAM_IDS (comma list).
import { admin } from "../_shared/common.ts";

const OPENID = "https://steamcommunity.com/openid/login";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const site = Deno.env.get("SITE_URL")!;
  const self = `${Deno.env.get("SUPABASE_URL")}/functions/v1/steam-login`;
  const back = (hash: string) => Response.redirect(`${site}#${hash}`, 302);

  if (url.searchParams.get("start")) {
    const p = new URLSearchParams({
      "openid.ns": "http://specs.openid.net/auth/2.0",
      "openid.mode": "checkid_setup",
      "openid.return_to": self,
      "openid.realm": new URL(self).origin,
      "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
      "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
    });
    return Response.redirect(`${OPENID}?${p}`, 302);
  }

  // Steam's callback: ask Steam itself whether this assertion is genuine.
  if (url.searchParams.get("openid.mode") !== "id_res") return back("/login-failed");
  if (url.searchParams.get("openid.return_to") !== self) return back("/login-failed");
  const check = new URLSearchParams(url.searchParams);
  check.set("openid.mode", "check_authentication");
  const v = await fetch(OPENID, { method: "POST", body: check, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  if (!(await v.text()).includes("is_valid:true")) return back("/login-failed");
  const m = (url.searchParams.get("openid.claimed_id") || "").match(/^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/);
  if (!m) return back("/login-failed");
  const steamId = m[1];

  // Public profile name + avatar (no API key needed).
  let name = "", avatar = "";
  try {
    const x = await (await fetch(`https://steamcommunity.com/profiles/${steamId}?xml=1`)).text();
    name = (x.match(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/) || [])[1] || "";
    avatar = (x.match(/<avatarMedium><!\[CDATA\[(.*?)\]\]><\/avatarMedium>/) || [])[1] || "";
  } catch { /* fine */ }

  const db = admin();
  const email = `${steamId}@steam.quantskins.invalid`;
  let { data: prof } = await db.from("skin_profiles").select("id").eq("steam_id", steamId).maybeSingle();
  if (!prof) {
    const { data: u, error } = await db.auth.admin.createUser({ email, email_confirm: true, user_metadata: { steam_id: steamId } });
    if (error || !u.user) return back("/login-failed");
    prof = { id: u.user.id };
  }
  const admins = (Deno.env.get("ADMIN_STEAM_IDS") || "").split(",").map((s) => s.trim());
  await db.from("skin_profiles").upsert({ id: prof.id, steam_id: steamId, name: name.slice(0, 64), avatar, is_admin: admins.includes(steamId) });

  const { data: link, error } = await db.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !link?.properties?.hashed_token) return back("/login-failed");
  return back(`/auth/${link.properties.hashed_token}`);
});
