#!/bin/sh
# Copies the Quant wallet library + base styles from quant-web (one source of truth).
set -e
cd "$(dirname "$0")/.."
W=${QUANT_WEB:-../quant-web/site}
cp "$W/js/quant.js" "$W/js/words.js" "$W/js/wallet.js" site/js/shared/
cp "$W/qcrypto.wasm" site/
cp "$W/css/app.css" site/css/base.css
