#!/usr/bin/env bash
#
# duman-testi.sh — ayakta olan yığına karşı GERÇEK bir tools/call koşturur.
#
# Bu betik ANA MAKİNEDE çalışır (bin/ altındakiler imajın İÇİNE girer; bu
# girmez — ayrım kasıtlıdır).
#
#   ./deploy/docker/duman-testi.sh
#   ./deploy/docker/duman-testi.sh ts        # yalnızca bir dil
#
# Sağlık kontrolü "sunucu ayakta" der; bu betik "sunucu DOĞRU CEVABI veriyor"
# der. İkisi farklı sorulardır: fixtures/ imaja girmemiş olsaydı sağlık
# kontrolü yine GEÇERDİ ama whoami çöpe düşerdi.
#
# ── Üç dil, üç FARKLI çağrı dizisi ───────────────────────────────────────────
# Bu betiğin uzunluğunun sebebi budur ve bulgunun kendisi budur:
#
#   TypeScript  POST /mcp   stateless, tek istek        (2026-07-28)
#   C#          POST /      stateless, tek istek        (2026-07-28)
#   Python      POST /mcp   initialize → session al →
#                           notifications/initialized → tools/call  (2025-11-25)
#
# Aynı sözleşme, aynı sonuç — ama taşıyıcı seviyesinde üç ayrı el sıkışma.
# Bkz. deploy/docker/KARARLAR.md → K-02, K-04.

set -uo pipefail

TS_URL="${TS_URL:-http://127.0.0.1:8788/mcp}"
PY_URL="${PY_URL:-http://127.0.0.1:8798/mcp}"
CS_URL="${CS_URL:-http://127.0.0.1:8808/}"

BEKLENEN_AD="Ay"          # "Ayşe Demir" — UTF-8/\u kaçışı fark etmesin diye kısa
BEKLENEN_ID="TW9jay9QZXJzb24vMQ"

gecti=0
kaldi=0

bildir() {
  local durum="$1" ad="$2" detay="$3"
  if [ "$durum" = "GECTI" ]; then
    printf '  \033[32mGEÇTİ\033[0m  %-12s %s\n' "$ad" "$detay"
    gecti=$((gecti + 1))
  else
    printf '  \033[31mKALDI\033[0m  %-12s %s\n' "$ad" "$detay"
    kaldi=$((kaldi + 1))
  fi
}

dogrula() {
  local ad="$1" yanit="$2"
  if [[ "$yanit" != *"$BEKLENEN_ID"* ]]; then
    bildir KALDI "$ad" "person.id bulunamadı → $(printf '%.160s' "$yanit")"
    return
  fi
  if [[ "$yanit" != *"$BEKLENEN_AD"* ]]; then
    bildir KALDI "$ad" "kişi adı bulunamadı → $(printf '%.160s' "$yanit")"
    return
  fi
  bildir GECTI "$ad" "xurrent_whoami → ${BEKLENEN_ID} (fixtures/ imajda, mock mod çalışıyor)"
}

# ── stateless yol: TypeScript ve C# ──────────────────────────────────────────
stateless_cagir() {
  local url="$1"
  curl --silent --show-error --max-time 10 -X POST "$url" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Mcp-Method: tools/call' \
    -H 'Mcp-Name: xurrent_whoami' \
    -H 'MCP-Protocol-Version: 2026-07-28' \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"xurrent_whoami","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}' 2>&1
}

# ── oturumlu yol: Python ─────────────────────────────────────────────────────
oturumlu_cagir() {
  local url="$1" basliklar oturum
  basliklar=$(mktemp)

  # 1) initialize — oturum kimliği YANIT HEADER'INDA döner.
  curl --silent --show-error --max-time 10 -D "$basliklar" -o /dev/null -X POST "$url" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Mcp-Method: initialize' \
    -H 'MCP-Protocol-Version: 2025-11-25' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"duman-testi","version":"1.0.0"}}}' 2>&1

  oturum=$(grep -i '^mcp-session-id:' "$basliklar" | tr -d '\r' | awk '{print $2}')
  rm -f "$basliklar"

  if [ -z "$oturum" ]; then
    echo "HATA: mcp-session-id header'ı gelmedi"
    return
  fi

  # 2) notifications/initialized — v1 el sıkışmasının kapanışı. Atlanırsa
  #    sunucu "received request before initialization was complete" der.
  curl --silent --show-error --max-time 10 -o /dev/null -X POST "$url" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "Mcp-Session-Id: ${oturum}" \
    -H 'MCP-Protocol-Version: 2025-11-25' \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' 2>&1

  # 3) tools/call — v1 şekli: _meta YOK, oturum header'ı VAR.
  curl --silent --show-error --max-time 10 -X POST "$url" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "Mcp-Session-Id: ${oturum}" \
    -H 'MCP-Protocol-Version: 2025-11-25' \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"xurrent_whoami","arguments":{}}}' 2>&1
}

hedef="${1:-hepsi}"

echo "xurrent-mcp — konteyner duman testi"
echo

case "$hedef" in
  hepsi|ts) dogrula "TypeScript" "$(stateless_cagir "$TS_URL")" ;;
esac
case "$hedef" in
  hepsi|py) dogrula "Python"     "$(oturumlu_cagir  "$PY_URL")" ;;
esac
case "$hedef" in
  hepsi|cs) dogrula "C#"         "$(stateless_cagir "$CS_URL")" ;;
esac

echo
echo "${gecti} geçti · ${kaldi} kaldı"
[ "$kaldi" -eq 0 ]
