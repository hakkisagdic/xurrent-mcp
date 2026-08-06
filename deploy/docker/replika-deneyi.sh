#!/usr/bin/env bash
#
# replika-deneyi.sh — XURRENT_STATE_SECRET'ın neden PAYLAŞILMAK ZORUNDA olduğunu
# İDDİA ETMEZ, GÖSTERİR.
#
#   ./deploy/docker/replika-deneyi.sh
#
# İki senaryoyu aynı MRTR onayı üzerinde koşturur:
#
#   A) İKİ REPLİKA, AYNI SIR      → 1. replika imzalar, 2. replika DOĞRULAR.
#                                    Yazma GERÇEKLEŞİR. Sticky session GEREKMEZ.
#   B) İKİ REPLİKA, SIR PAYLAŞILMADI → 2. replika kendi rastgele anahtarını
#                                    üretmiştir. İmza TUTMAZ, yazma REDDEDİLİR.
#
# B senaryosu üretimde şöyle görünür: kullanıcı "onayladım ama yazılmadı" der,
# yük dengeleyici sağlıklıdır, sunucu logunda yalnızca "imza geçersiz" yazar ve
# hangi replikanın imzaladığı HİÇBİR YERDE YOKTUR. Bu betik o arızayı 40 saniyede
# ve güvenli biçimde yeniden üretir.
#
# Neden `XURRENT_CONFIRM_POLICY=strict`: mock modda varsayılan `closed` onayı hiç
# tetiklemez (.env.example:104), dolayısıyla MRTR'nin mutlu yolu görülemez.
# `strict` mock modda DA onay sorar — deneyin var olma sebebi budur.

set -uo pipefail

IMAJ="${IMAJ:-xurrent-mcp-typescript:draft}"
SIR="deney-icin-paylasilan-sir"
A_PORT=19101   # imzalayan replika
B_PORT=19102   # AYNI sırra sahip replika
C_PORT=19103   # sır paylaşılmamış replika (rastgele anahtar)

TEMIZLE() { docker rm -f deney-a deney-b deney-c >/dev/null 2>&1 || true; }
trap TEMIZLE EXIT

if ! docker image inspect "$IMAJ" >/dev/null 2>&1; then
  echo "İmaj yok: $IMAJ"
  echo "Önce:  docker build -f deploy/docker/Dockerfile.typescript -t $IMAJ ."
  exit 1
fi

TEMIZLE
echo "Üç replika başlatılıyor…"
docker run -d --name deney-a -p ${A_PORT}:8788 \
  -e XURRENT_CONFIRM_POLICY=strict -e XURRENT_STATE_SECRET="$SIR" "$IMAJ" >/dev/null
docker run -d --name deney-b -p ${B_PORT}:8788 \
  -e XURRENT_CONFIRM_POLICY=strict -e XURRENT_STATE_SECRET="$SIR" "$IMAJ" >/dev/null
# ⬇ SIR VERİLMEDİ: süreç başlangıcında rastgele üretilir (config: boşsa random).
docker run -d --name deney-c -p ${C_PORT}:8788 \
  -e XURRENT_CONFIRM_POLICY=strict "$IMAJ" >/dev/null

until [ "$(docker ps --filter name=deney- --format '{{.Status}}' | grep -c healthy)" -ge 3 ]; do
  sleep 2
done
echo "Üç replika hazır."
echo

ORTAK_ARG='{"targetType":"request","targetId":"TW9jay9SZXF1ZXN0LzcwMjQ4","minutes":120,"description":"Replika deneyi"}'

# ── 1) A replikasından onay isteği al ────────────────────────────────────────
ADIM1=$(curl --silent --show-error --max-time 15 -X POST "http://127.0.0.1:${A_PORT}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Mcp-Method: tools/call' -H 'Mcp-Name: xurrent_create_time_entry' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"xurrent_create_time_entry\",\"arguments\":${ORTAK_ARG},\"_meta\":{\"io.modelcontextprotocol/protocolVersion\":\"2026-07-28\",\"io.modelcontextprotocol/clientCapabilities\":{\"elicitation\":{}}}}}")

REQUEST_STATE=$(printf '%s' "$ADIM1" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const t = s.includes("data: ") ? s.slice(s.indexOf("data: ")+6) : s;
    try { console.log(JSON.parse(t).result?.requestState ?? ""); } catch { console.log(""); }
  });')

if [ -z "$REQUEST_STATE" ]; then
  echo "requestState alınamadı. Ham yanıt:"
  printf '%.400s\n' "$ADIM1"
  exit 1
fi

echo "1) A replikası (:${A_PORT}) onay istedi."
echo "   requestState: ${#REQUEST_STATE} karakter, imzalı — '${REQUEST_STATE:0:16}…'"
echo

# ── 2) Onaylanmış isteği başka bir replikaya götür ───────────────────────────
tekrarla() {
  curl --silent --show-error --max-time 15 -X POST "http://127.0.0.1:${1}/mcp" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Mcp-Method: tools/call' -H 'Mcp-Name: xurrent_create_time_entry' \
    -H 'MCP-Protocol-Version: 2026-07-28' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"xurrent_create_time_entry\",\"arguments\":${ORTAK_ARG},\"inputResponses\":{\"onay\":{\"action\":\"accept\",\"content\":{\"onay\":true}}},\"requestState\":\"${REQUEST_STATE}\",\"_meta\":{\"io.modelcontextprotocol/protocolVersion\":\"2026-07-28\",\"io.modelcontextprotocol/clientCapabilities\":{\"elicitation\":{}}}}}"
}

basarili=0

echo "2) AYNI onay, B replikasına (:${B_PORT}) — SIR PAYLAŞILMIŞ"
YANIT_B=$(tekrarla "$B_PORT")
if [[ "$YANIT_B" == *"GERÇEK YAZMA"* || "$YANIT_B" == *"timeEntry"*"id"* ]] && [[ "$YANIT_B" != *"DOĞRULANAMADI"* ]]; then
  printf '   \033[32mYAZILDI\033[0m — imza tuttu. Onay replikalar arasında TAŞINDI.\n'
  printf '           Sticky session GEREKMEDİ; stateless vaadi gerçek oldu.\n'
else
  printf '   \033[31mBEKLENMEYEN\033[0m — paylaşılan sırla yazma başarısız oldu:\n'
  printf '   %.300s\n' "$YANIT_B"
  basarili=1
fi
echo

echo "3) AYNI onay, C replikasına (:${C_PORT}) — SIR PAYLAŞILMAMIŞ"
YANIT_C=$(tekrarla "$C_PORT")
if [[ "$YANIT_C" == *"DOĞRULANAMADI"* || "$YANIT_C" == *"GEÇERSİZ"* ]]; then
  printf '   \033[31mREDDEDİLDİ\033[0m — imza tutmadı. İşte üretimdeki o sessiz arıza.\n'
  printf '           Kullanıcı: "onayladım ama yazılmadı." Logda yalnızca "imza geçersiz".\n'
else
  printf '   \033[31mBEKLENMEYEN\033[0m — sır paylaşılmadığı hâlde yazma geçti:\n'
  printf '   %.300s\n' "$YANIT_C"
  basarili=1
fi

echo
echo "──────────────────────────────────────────────────────────────────────"
echo "SONUÇ: XURRENT_STATE_SECRET bir ayar değil, DOĞRULUK KOŞULUDUR."
echo "       Çok replikalı HTTP dağıtımında paylaşılmazsa onay akışı"
echo "       replika sayısıyla orantılı biçimde SESSİZCE kırılır."
echo "──────────────────────────────────────────────────────────────────────"
exit $basarili
