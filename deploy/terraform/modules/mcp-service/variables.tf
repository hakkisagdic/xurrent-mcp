# ─────────────────────────────────────────────────────────────────────────────
# ARAYUZ SOZLESMESI
#
# Bu dosya "bir xurrent-mcp servisi dagitmak icin bilinmesi gereken her sey"in
# tam listesidir. Icinde tek bir bulut saglayici adi gecmez — var.platform
# disinda, o da yalnizca hangi implementasyonun secilecegini soyler.
#
# Yeni bir platform eklemek: modules/platform-<ad>/ altinda ayni girdileri kabul
# eden bir modul yaz ve main.tf'teki dispatch'e ekle. BU DOSYA DEGISMEZ.
#
# Bicim notu: uzun aciklamalar bilerek heredoc yerine yorum satirlarinda.
# `terraform fmt` blok govdesindeki ardisik atama satirlarinin `=` isaretlerini
# hizalar; araya giren heredoc govdesi ya da yorum bu zinciri kirar ve elle
# yazilmis dosyanin `fmt -check`ten gecmemesine yol acar. Yorumlari blogun
# USTUNE koymak bu belirsizligi tamamen ortadan kaldirir.
# ─────────────────────────────────────────────────────────────────────────────


# Hangi platform implementasyonu kullanilacak.
#
# Bugun yalnizca "gcp-cloud-run" implemente edilmistir. Secim gerekcesi ve
# alternatifleri (Azure Container Apps, AWS App Runner, ...) icin:
# docs/15-dagitim.md § K2.
#
# TODO(karar): diger platform modulleri henuz YOK. Kullanici platformu secmeden
# ucunu birden yazmak, ucu de denenmemis uc iskelet uretmek demektir.
variable "platform" {
  description = "Platform implementasyonu. Su an yalnizca \"gcp-cloud-run\"."
  type        = string
  default     = "gcp-cloud-run"

  validation {
    condition     = contains(["gcp-cloud-run"], var.platform)
    error_message = "Su an yalnizca \"gcp-cloud-run\" implemente edildi. Bkz. docs/15-dagitim.md § K2."
  }
}

# Bilerek varsayilan YOK: bu repoda uydurma bir proje kimligi bulunmaz.
variable "gcp_project_id" {
  description = "platform = \"gcp-cloud-run\" icin proje kimligi."
  type        = string
  default     = null

  validation {
    condition     = var.platform != "gcp-cloud-run" || var.gcp_project_id != null
    error_message = "platform = \"gcp-cloud-run\" iken gcp_project_id zorunludur."
  }
}

# Bolge secimi ayni zamanda bir VERI IKAMETI kararidir ve Xurrent'in kendi
# bolgesiyle birlikte dusunulmelidir: docs/15-dagitim.md § K9.
variable "gcp_region" {
  description = "platform = \"gcp-cloud-run\" icin bolge."
  type        = string
  default     = null

  validation {
    condition     = var.platform != "gcp-cloud-run" || var.gcp_region != null
    error_message = "platform = \"gcp-cloud-run\" iken gcp_region zorunludur."
  }
}

# Uretilecek tum kaynaklarin ad oneki. Ortamlar arasi ad carpismasini engeller.
variable "name_prefix" {
  description = "Kaynak ad oneki."
  type        = string
  default     = "xurrent-mcp"

  validation {
    condition     = can(regex("^[a-z]([-a-z0-9]{0,30}[a-z0-9])?$", var.name_prefix))
    error_message = "name_prefix kucuk harf/rakam/tire olmali, harfle baslamali, en fazla 32 karakter."
  }
}

# Calistirilacak konteyner imajinin tam referansi.
#
# Imajlar deploy/docker/Dockerfile.<dil> ile uretilir (derleme baglami DEPO
# KOKU olmak zorunda: uc sunucu da contract/ ve fixtures/ okur).
# Hangi dilin dagitilacagi bir karardir: docs/15-dagitim.md § K1.
#
# ★ Python ve C# imajlari bir LOOPBACK KOPRUSU ile calisir, cunku bu iki sunucu
#   dinleme adresini kod icinde 127.0.0.1'e cakiyor. Kopru bir YAMADIR;
#   sozlesmesi KOPRU_PORT_DEGISKENI ile kurulur (bkz. main.tf).
#   Ayrinti: docs/15-dagitim.md § "Dagitim onkosullari".
#
# Digest ile sabitlemek (repo@sha256:...) etiketten yegdir: ":latest" bir
# sonraki dagitimda sessizce baska bir imaj demektir.
variable "image" {
  description = "Konteyner imaji (tercihen digest ile sabitlenmis)."
  type        = string

  validation {
    condition     = length(trimspace(var.image)) > 0
    error_message = "image bos olamaz."
  }
}

# Konteynerin hangi giris noktasini calistirdigi.
#
#   "http" → MCP Streamable HTTP tasiyicisi (varsayilan).
#            GEMINI_API_KEY GEREKMEZ; LLM'i host uygulama saglar.
#   "web"  → tarayici sohbet arayuzu. GEMINI_API_KEY GEREKIR.
#
# ★ Bu, XURRENT_MODE (mock/live) ile KARISTIRILMAMALIDIR. Ikisi de "mod" der;
#   biri "hangi surec", digeri "hangi veri kaynagi" sorusunu cevaplar.
variable "server_mode" {
  description = "Konteyner giris noktasi: \"http\" (MCP) veya \"web\" (sohbet arayuzu)."
  type        = string
  default     = "http"

  validation {
    condition     = contains(["http", "web"], var.server_mode)
    error_message = "server_mode yalnizca \"http\" veya \"web\" olabilir."
  }
}

# Konteynerin dinledigi TCP portu.
#
# Uygulama bu degeri MCP_HTTP_PORT (server_mode = "http") ya da WEB_PORT
# (server_mode = "web") degiskeninden okur. Cloud Run ayrica PORT degiskenini
# enjekte eder ama UYGULAMA PORT'U OKUMAZ — bu yuzden platform modulu ucunu de
# ayni degere ayarlar.
variable "port" {
  description = "Konteynerin dinledigi TCP portu."
  type        = number
  default     = 8788

  validation {
    condition     = var.port > 0 && var.port < 65536
    error_message = "port 1–65535 araliginda olmali."
  }
}


# ─────────────────────────────────────────────────────────────────────────────
# OLCEKLENME
# ─────────────────────────────────────────────────────────────────────────────

# En az calisan ornek sayisi. 0 = sifira olceklenir, bosta maliyet ~yok.
#
# ★ 0'in gorunmeyen bedeli: requestState'in tek kullanimlik `nonce` seti SUREC
#   ICINDEDIR (servers/typescript/src/core/confirm.ts:76 — `new Set<string>()`).
#   Surec olup yeniden dogunca set BOSALIR, ama imza anahtari artik SABIT oldugu
#   icin eski state'ler HALA GECERLIDIR. Yani sifira olceklenme, TTL suresi
#   boyunca bir tekrar-oynatma penceresi acar.
#   Ayrinti: docs/15-dagitim.md § "Sabit sirrin bedeli".
variable "min_replicas" {
  description = "En az ornek sayisi (0 = sifira olceklenir)."
  type        = number
  default     = 0

  validation {
    condition     = var.min_replicas >= 0
    error_message = "min_replicas negatif olamaz."
  }
}

# En cok calisan ornek sayisi.
#
# ★ 1'den buyuk her deger, XURRENT_STATE_SECRET'in TUM REPLIKALARDA AYNI olmasini
#   SART kosar. Bu modul sirri kendisi uretip sir deposuna yazar ve tum
#   replikalara ayni referansi verir; sart boylece saglanir. Sirri elle, replika
#   basina farkli vermeye kalkan bir kurulum ONAY AKISINI KIRAR ve bu HICBIR
#   LOGDA GORUNMEZ. Ayrinti: docs/15-dagitim.md § "Kirilma senaryosu".
variable "max_replicas" {
  description = "En cok ornek sayisi."
  type        = number
  default     = 3

  validation {
    condition     = var.max_replicas >= 1
    error_message = "max_replicas en az 1 olmali."
  }

  validation {
    condition     = var.max_replicas >= var.min_replicas
    error_message = "max_replicas, min_replicas'tan kucuk olamaz."
  }
}

variable "max_concurrency" {
  description = "Bir orneğin es zamanli kabul ettigi istek sayisi."
  type        = number
  default     = 40
}

variable "cpu" {
  description = "Ornek basina CPU (platform notasyonu, orn. \"1\")."
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Ornek basina bellek (platform notasyonu, orn. \"512Mi\")."
  type        = string
  default     = "512Mi"
}

# Istek zaman asimi.
#
# MRTR akisinda tek bir HTTP istegi UZUN SURMEZ: sunucu "input_required" donup
# istegi SONLANDIRIR, kullanici dusunurken hicbir baglanti acik kalmaz. Yani bu
# deger onay suresine gore degil, Xurrent GraphQL cagrilarinin suresine gore
# secilir.
variable "request_timeout_seconds" {
  description = "Istek zaman asimi (saniye)."
  type        = number
  default     = 60
}


# ─────────────────────────────────────────────────────────────────────────────
# ERISIM
# ─────────────────────────────────────────────────────────────────────────────

# ★★★ TEHLIKELI. true yapmadan once docs/15-dagitim.md § K4'u okuyun.
#
# Bu repodaki MCP HTTP tasiyicisinda HICBIR KIMLIK DOGRULAMA YOKTUR — uc dilde de
# yok (arandi, bulunamadi). Endpoint'i herkese acmak, Xurrent hesabiniza YAZMA
# yetkisi olan bir ucu internete acmak demektir. Onay akisi bir LLM'i degil bir
# KULLANICIYI hedefler; kimlik dogrulamasiz bir ucta "kullanici" kavrami yoktur.
variable "allow_unauthenticated" {
  description = "Servisi kimlik dogrulamasiz herkese acar. Varsayilan false."
  type        = bool
  default     = false
}

# Ag seviyesinde kimin ulasabildigi (platform notasyonu).
# Cloud Run: INGRESS_TRAFFIC_ALL · INGRESS_TRAFFIC_INTERNAL_ONLY ·
#            INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER
variable "ingress" {
  description = "Ag giris politikasi (platform notasyonu)."
  type        = string
  default     = "INGRESS_TRAFFIC_ALL"
}


# ─────────────────────────────────────────────────────────────────────────────
# UYGULAMA YAPILANDIRMASI — sir OLMAYAN her sey
# ─────────────────────────────────────────────────────────────────────────────

# "mock" → fixtures/ klasorunden okur, yazmalar bellekte. Token GEREKMEZ.
# "live" → gercek Xurrent GraphQL API'si. XURRENT_TOKEN GEREKIR.
#
# Varsayilanin ne olmasi gerektigi bir karardir: docs/15-dagitim.md § K3.
# Bu modulde varsayilan "mock"tur, cunku yanlislikla canliya yazmak yanlislikla
# mock'a yazmaktan cok daha pahalidir.
variable "xurrent_mode" {
  description = "Xurrent adaptoru: \"mock\" veya \"live\"."
  type        = string
  default     = "mock"

  validation {
    condition     = contains(["mock", "live"], var.xurrent_mode)
    error_message = "xurrent_mode yalnizca \"mock\" veya \"live\" olabilir."
  }
}

# true iken HICBIR mutation Xurrent'a gitmez; planlanan GraphQL cagrilari doner.
#
# Ilk canli dagitimda true birakilmasi siddetle tavsiye edilir: live + dry_run
# kombinasyonu "kimlik dogrulama ve sorgular calisiyor mu" sorusunu hicbir kayit
# yazmadan cevaplar.
variable "xurrent_dry_run" {
  description = "Mutation'lari gondermeden plan dondurur."
  type        = bool
  default     = true
}

variable "xurrent_account" {
  description = "X-Xurrent-Account basligi. NUMERIK DEGIL, kisa slug. Sir DEGILDIR."
  type        = string
  default     = ""
}

# ⚠️ "eu" diye bir bolge YOKTUR. graphql.eu.xurrent.com wildcard DNS ile cozulur
#    ama TLS hatasi verir. Global zaten Avrupa'dir.
variable "xurrent_graphql_url" {
  description = "Xurrent GraphQL ucu."
  type        = string
  default     = "https://graphql.xurrent.com"
}

# Sunucunun konustugu MCP revizyonu.
#
#   "2026-07-28" → yalnizca /mcp/v2 (/mcp de buraya yonlenir)
#   "2025-11-25" → yalnizca /mcp/v1 (/mcp de buraya yonlenir)
#   "both"       → ikisi de ayri yollarda. ★ Bu durumda /mcp BELIRSIZDIR ve 404
#                  doner (servers/typescript/src/mcp/http.ts:131). Saglik
#                  kontrolunu /mcp uzerinden kurmayin.
variable "mcp_protocol" {
  description = "MCP revizyonu: \"2026-07-28\", \"2025-11-25\" veya \"both\"."
  type        = string
  default     = "2026-07-28"

  validation {
    condition     = contains(["2026-07-28", "2025-11-25", "both"], var.mcp_protocol)
    error_message = "mcp_protocol: \"2026-07-28\", \"2025-11-25\" veya \"both\"."
  }
}

# Client onay diyalogunu desteklemiyorsa ne olacak?
#
#   "closed" → VARSAYILAN, guvenli. live modda yazma REDDEDILIR.
#   "open"   → onaysiz yazilir. YALNIZCA CI/otomasyon icin. Dagitimda KULLANMAYIN.
#   "strict" → mock modda DA onay sorulur (ders demosu icin).
variable "confirm_policy" {
  description = "Onay politikasi: \"closed\", \"open\" veya \"strict\"."
  type        = string
  default     = "closed"

  validation {
    condition     = contains(["closed", "open", "strict"], var.confirm_policy)
    error_message = "confirm_policy: \"closed\", \"open\" veya \"strict\"."
  }

  validation {
    condition     = !(var.confirm_policy == "open" && var.xurrent_mode == "live")
    error_message = "confirm_policy = \"open\" ile xurrent_mode = \"live\" birlikte kullanilamaz: onaysiz canli yazma."
  }
}

# requestState gecerlilik suresi. Tekrar-oynatma penceresini daraltir.
#
# ★ Cok replikali ve/veya sifira olceklenen bir dagitimda bu deger, nonce seti
#   kaybolduktan sonra kalan TEK savunmadir. Kucuk tutun.
variable "state_ttl_seconds" {
  description = "requestState TTL (saniye)."
  type        = number
  default     = 300

  validation {
    condition     = var.state_ttl_seconds > 0 && var.state_ttl_seconds <= 3600
    error_message = "state_ttl_seconds 1–3600 araliginda olmali."
  }
}

variable "timezone" {
  description = "IANA saat dilimi. Takvim penceresi bu dilimin YEREL gece yarilarina gore kurulur."
  type        = string
  default     = "Europe/Istanbul"
}

# Takvim saglayicisi.
#
# ★ "google" ve "graph" DAGITIMDA CALISMAZ ve bu sessiz bir hatadir:
#   Google akisi OAuth token'ini ~/.xurrent-mcp/google-token.json dosyasina yazar
#   (README § "Takvim saglayicilari"). Konteynerin dosya sistemi EFEMERDIR ve
#   replikalar arasinda PAYLASILMAZ — token her yeniden baslatmada kaybolur,
#   yenileme yazilamaz. Graph icin de ayni sinif sorun gecerlidir.
#   Dagitimda desteklenen: "mock" ve "ics" (yayinlanmis URL ile).
#   Karar: docs/15-dagitim.md § K10.
variable "calendar_provider" {
  description = "Takvim saglayicisi. Dagitimda yalnizca \"mock\" veya \"ics\"."
  type        = string
  default     = "mock"

  validation {
    condition     = contains(["mock", "ics"], var.calendar_provider)
    error_message = "Dagitimda yalnizca \"mock\" ve \"ics\" desteklenir: \"google\"/\"graph\" kalici token dosyasi ister, konteynerde yoktur. Bkz. docs/15-dagitim.md § K10."
  }
}

# Ek ortam degiskenleri — SIR OLMAYANLAR.
#
# ★ Buraya sir yazmayin: bu deger Terraform state'ine ve platform API'sine DUZ
#   METIN gider. Sirlar icin *_secret_id degiskenlerini kullanin. Asagidaki
#   validation, sir gorunumlu anahtar adlarini reddederek bunu zorlar.
variable "extra_env" {
  description = "Ek ortam degiskenleri (sir olmayanlar)."
  type        = map(string)
  default     = {}

  validation {
    condition     = length([for k in keys(var.extra_env) : k if can(regex("(?i)(token|secret|key|password|credential)", k))]) == 0
    error_message = "extra_env icinde sir gorunumlu bir anahtar var (token/secret/key/password/credential). Sirlar sir deposundan gelmeli."
  }
}

variable "labels" {
  description = "Kaynak etiketleri (maliyet dagitimi ve envanter icin)."
  type        = map(string)
  default     = {}
}


# ─────────────────────────────────────────────────────────────────────────────
# SIRLAR
#
# ★ Bu bolumde SIRRIN KENDISI YOKTUR — yalnizca sir deposundaki KIMLIGI vardir.
#   Hicbir sir tfvars'a, state'e ya da imaja duz metin girmez.
#
#   XURRENT_STATE_SECRET burada YOKTUR, cunku onu Terraform'un KENDISI URETIR
#   (main.tf). Bkz. docs/15-dagitim.md § "Uc sir, uc farkli yasam dongusu".
# ─────────────────────────────────────────────────────────────────────────────

# XURRENT_TOKEN'i tutan VAR OLAN sirrin kimligi.
#
# null (varsayilan) → Terraform BOS bir sir kabi olusturur; degeri siz kurulum
#   disinda (konsol / CLI / CD) yazarsiniz. Deger yoksa dagitim BASARISIZ olur —
#   bu istenen davranistir (fail-closed): tokensiz bir "live" servis ayaga
#   kalkmasin.
#
# ★ Terraform bu sirri asla OKUMAZ. Okusa state'e duz metin yazardi.
variable "xurrent_token_secret_id" {
  description = "XURRENT_TOKEN'i tutan var olan sirrin kimligi. null ise bos kap olusturulur."
  type        = string
  default     = null
}

# GEMINI_API_KEY'i tutan VAR OLAN sirrin kimligi.
#
# Yalnizca server_mode = "web" iken gereklidir. MCP HTTP tasiyicisi LLM CAGIRMAZ;
# LLM'i host uygulama saglar. MCP sunucusu dagitiyorsaniz bu sirra hic ihtiyaciniz
# yoktur ve modul onu olusturmaz.
variable "gemini_api_key_secret_id" {
  description = "GEMINI_API_KEY'i tutan var olan sirrin kimligi. null ise bos kap olusturulur."
  type        = string
  default     = null
}

# Uretilecek XURRENT_STATE_SECRET uzunlugu (karakter).
#
# HMAC-SHA256 icin 32 bayttan uzun anahtarin ek faydasi yoktur (icerde ozetlenir)
# ama 64 karakter okunabilirlik ve marj icin makul bir varsayilandir.
variable "state_secret_length" {
  description = "Uretilen XURRENT_STATE_SECRET uzunlugu."
  type        = number
  default     = 64

  validation {
    condition     = var.state_secret_length >= 32
    error_message = "state_secret_length en az 32 olmali."
  }
}

# Gerekli platform API'lerini Terraform etkinlestirsin mi?
#
# false (varsayilan): projeyi baska bir ekip yonetiyorsa dogru secim.
# true: sifirdan bir proje kuruyorsaniz ilk apply'in "API etkin degil" hatasiyla
#       dusmesini engeller.
variable "enable_apis" {
  description = "Gerekli platform API'lerini Terraform etkinlestirsin mi?"
  type        = bool
  default     = false
}
