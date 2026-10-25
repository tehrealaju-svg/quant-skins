# Quant Skins

Buy, sell and swap CS2 skins for QNT, like trade-it. Prices come from csgoskins.gg per wear,
and inside each wear band a lower float costs more (smooth curve, up to +30% at the best float,
then a jump to the next wear's price).

* Sign in through Steam (Steam's page has the QR code for the Steam app).
* Payments are real Quant transactions, signed in the browser with the same wallet as the Quant site.
* Orders, listings and settings live in Supabase; row-level security keeps users to their own data.
* The admin page beeps + shows a desktop notification when an order arrives or gets paid.

## Layout
```
site/                 static site (GitHub Pages)
  js/app.js           market, trade (buy/sell/swap), orders, account, admin
  js/shared/          Quant wallet library copied from quant-web (tools/sync-shared.sh)
supabase/skins.sql    tables, pricing function, order placement, security
supabase/functions/   steam-login, inventory, prices (csgoskins.gg), verify-payment
```

## Deploying the functions
```
npx supabase login
npx supabase functions deploy steam-login --no-verify-jwt --project-ref tizxmikbkrubyeuktxxg
npx supabase functions deploy inventory prices verify-payment --project-ref tizxmikbkrubyeuktxxg
npx supabase secrets set --project-ref tizxmikbkrubyeuktxxg SITE_URL=https://tehrealaju-svg.github.io/quant-skins/ ADMIN_STEAM_IDS=<your 17-digit id> QUANT_NETWORK=test
```
