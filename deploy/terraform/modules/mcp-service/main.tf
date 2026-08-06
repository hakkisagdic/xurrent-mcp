# ═════════════════════════════════════════════════════════════════════════════
# ★★★ BU MODULUN VAROLUS SEBEBI: PAYLASILAN requestState IMZA ANAHTARI
#
# MCP 2026-07-28 revizyonu STATELESS'tir. Onay akisinda (MRTR) sunucu
# "kullanici X, Request #70248'e 120 dakika yazmayi onayladi" bilgisini bellekte
# TUTAMAZ — HMAC ile imzalayip `requestState` adiyla ISTEMCIYE EMANET EDER.
# Istemci ikinci istekte onu geri getirir.
#
# Imza anahtari XURRENT_STATE_SECRET'tir ve BOS BIRAKILIRSA her surec kendi
# rastgele anahtarini uretir (servers/typescript/src/core/confirm.ts:61-73).
# Tek surecte bu dogru davranistir: sunucu yeniden baslayinca bekleyen onaylar
# duser.
#
# COK REPLIKALI bir HTTP dagitiminda ise AYNI davranis akisi KIRAR:
# ikinci istek baska bir replikaya duserse imza dogrulanamaz ve yazma yapilmaz.
# Kullanici "onayladim ama yazilmadi" der; hicbir logda bir hata gorunmez.
#
# BU YUZDEN: anahtar Terraform tarafindan BIR KEZ uretilir, sir deposuna yazilir
# ve TUM replikalara AYNI referans verilir.
#
# ★ Anahtarin uretimi bilerek PLATFORM-BAGIMSIZ katmandadir: bu kisit MCP'den
#   gelir, buluttan degil. Platform modulu yalnizca "bu degeri sir deposuna yaz
#   ve konteynere bagla" isini yapar.
#
# Adim adim kirilma senaryosu: docs/15-dagitim.md § "Kirilma senaryosu".
# ═════════════════════════════════════════════════════════════════════════════

# ROTASYON: bu kaynagi degistirmek (terraform apply -replace) yeni bir anahtar
# uretir. Bedeli KUCUKTUR ve bilinir: rotasyon aninda ucusta olan onaylar duser,
# kullanici onayi tekrarlar. TTL zaten 5 dakikadir. Rotasyonu bir felaket degil
# bir bakim isi olarak planlayin.
resource "random_password" "state_secret" {
  length  = var.state_secret_length
  special = false
}

locals {
  # Sir OLMAYAN ortam degiskenleri. Hepsi platform API'sine ve Terraform
  # state'ine DUZ METIN gider — buraya asla sir konmaz.
  app_env = {
    # Xurrent adaptoru, MCP davranisi ve takvim.
    XURRENT_MODE           = var.xurrent_mode
    XURRENT_DRY_RUN        = var.xurrent_dry_run ? "1" : "0"
    XURRENT_ACCOUNT        = var.xurrent_account
    XURRENT_GRAPHQL_URL    = var.xurrent_graphql_url
    XURRENT_CONFIRM_POLICY = var.confirm_policy
    XURRENT_STATE_TTL      = tostring(var.state_ttl_seconds)
    XURRENT_TIMEZONE       = var.timezone
    MCP_PROTOCOL           = var.mcp_protocol
    CALENDAR_PROVIDER      = var.calendar_provider

    # Portlar: uygulama MCP_HTTP_PORT (http) ya da WEB_PORT (web) okur; Cloud Run
    # ayrica PORT enjekte eder ve UYGULAMA PORT'U OKUMAZ. Ucu de ayni degere
    # ayarlanir ki hangi tarafin kazandigi onemli olmasin.
    MCP_HTTP_PORT = tostring(var.port)
    WEB_PORT      = tostring(var.port)
    PORT          = tostring(var.port)

    # ★ LOOPBACK KOPRUSU ILE SOZLESME
    #
    # deploy/docker/Dockerfile.python ve .csharp, uygulamayi
    # deploy/docker/bin/loopback-kopru.sh ile sarar: sunucular dinleme adresini
    # KOD ICINDE 127.0.0.1'e cakiyor ve disaridan ezilemiyor (olculdu: C#'ta
    # ASPNETCORE_URLS bile UseUrls'i ezmiyor). Kopru 0.0.0.0:<port>'u dinleyip
    # uygulamayi 127.0.0.1:<port+10000>'e itiyor.
    #
    # Kopru HANGI degiskenin disa acik portu tasidigini bu degiskenden ogrenir.
    # Yanlis verilirse socat hicbir seyin dinlemedigi bir ic porta baglanir ve
    # servis "ayakta ama cevapsiz" olur — yine SESSIZ bir kirilma.
    #
    # TypeScript imajinda kopru yoktur; degisken orada okunmaz, zararsizdir.
    KOPRU_PORT_DEGISKENI = var.server_mode == "web" ? "WEB_PORT" : "MCP_HTTP_PORT"
  }

  plain_env = merge(local.app_env, var.extra_env)

  # Hangi sirrin gercekten gerektigi UYGULAMA bilgisidir, platform bilgisi degil.
  # Bu yuzden karar burada verilir ve platform modulune yalnizca "gerekli mi"
  # sorusunun cevabi gecer.
  #
  #   XURRENT_TOKEN → sadece live modda anlamlidir. mock modda hic okunmaz.
  #   GEMINI_API_KEY → sadece web (sohbet) modunda anlamlidir. MCP HTTP tasiyicisi
  #                    LLM CAGIRMAZ; LLM'i host uygulama saglar.
  needs_xurrent_token = var.xurrent_mode == "live"
  needs_gemini        = var.server_mode == "web"

  # MCP_PROTOCOL = "both" iken /mcp BELIRSIZDIR ve 404 doner
  # (servers/typescript/src/mcp/http.ts:131). Istemciye verilecek adres bu yuzden
  # acik yol olmalidir.
  mcp_path = var.mcp_protocol == "both" ? "/mcp/v2" : "/mcp"

  # Ozet cikti: dagitimi devralan kisi "onay akisi bu kurulumda neden calisiyor"
  # sorusunun cevabini `terraform output` ile gorsun. Bu bir suslemem degil —
  # kirilma sessiz oldugu icin, dogru kurulumun KANITININ da gorunur olmasi lazim.
  onay_akisi_ozeti = join(" ", [
    "XURRENT_STATE_SECRET Terraform tarafindan uretildi ve sir deposunda tutuluyor;",
    "${var.min_replicas}–${var.max_replicas} replikanin HEPSI AYNI degeri okuyor.",
    "Bu yuzden sticky session GEREKMIYOR: ikinci istek hangi replikaya duserse dussun imza dogrulanir.",
    var.min_replicas == 0 ? "UYARI: min_replicas = 0 — surec olup dogunca tek kullanimlik nonce seti bosalir, TTL boyunca tekrar-oynatma penceresi acilir." : "",
  ])
}

# ─────────────────────────────────────────────────────────────────────────────
# PLATFORM DISPATCH
#
# Bu, tum dosya agacinda somut bir bulut saglayicisinin adinin gectigi TEK yer.
# `count` ile secilir: secilmeyen platformun modulu hic ornek uretmez.
#
# TODO(karar): ikinci bir platform eklendiginde buraya ikinci bir `module`
# blogu gelir ve outputs.tf'teki `one(...)` ifadeleri `coalesce(...)` olur.
# Bunu simdiden yazmiyoruz: kullanici platformu secmeden yazilan ikinci modul,
# hicbir zaman calistirilmamis olur.
# ─────────────────────────────────────────────────────────────────────────────

module "gcp_cloud_run" {
  source = "../platform-gcp-cloud-run"
  count  = var.platform == "gcp-cloud-run" ? 1 : 0

  project_id  = var.gcp_project_id
  region      = var.gcp_region
  name_prefix = var.name_prefix
  enable_apis = var.enable_apis
  labels      = var.labels

  image     = var.image
  port      = var.port
  plain_env = local.plain_env

  min_replicas            = var.min_replicas
  max_replicas            = var.max_replicas
  max_concurrency         = var.max_concurrency
  cpu                     = var.cpu
  memory                  = var.memory
  request_timeout_seconds = var.request_timeout_seconds

  allow_unauthenticated = var.allow_unauthenticated
  ingress               = var.ingress

  state_secret_value       = random_password.state_secret.result
  needs_xurrent_token      = local.needs_xurrent_token
  xurrent_token_secret_id  = var.xurrent_token_secret_id
  needs_gemini             = local.needs_gemini
  gemini_api_key_secret_id = var.gemini_api_key_secret_id
}
