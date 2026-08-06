# ─────────────────────────────────────────────────────────────────────────────
# API'ler
#
# Varsayilan olarak KAPALI: projeyi baska bir ekip yonetiyorsa API etkinlestirme
# yetkisi zaten sizde olmayabilir ve apply yetki hatasiyla duser.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_project_service" "required" {
  for_each = var.enable_apis ? toset(["run.googleapis.com", "secretmanager.googleapis.com"]) : toset([])

  project = var.project_id
  service = each.value

  # destroy sirasinda API'yi KAPATMA: ayni projede baska servisler de onu
  # kullaniyor olabilir. Bu, "kendi ayagina sikma" korumasidir.
  disable_on_destroy = false
}

# ─────────────────────────────────────────────────────────────────────────────
# CALISMA KIMLIGI
#
# Varsayilan Compute Engine servis hesabi BILEREK kullanilmiyor: o hesap projede
# genis yetkilere sahiptir. Bu servisin ihtiyaci olan tek yetki, kendi sirlarini
# okumaktir.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-run"
  display_name = "xurrent-mcp Cloud Run calisma kimligi"
}

# ═════════════════════════════════════════════════════════════════════════════
# ★★★ XURRENT_STATE_SECRET — PAYLASILAN IMZA ANAHTARI
#
# Deger ust modulde (modules/mcp-service) uretilir; burada yalnizca sir deposuna
# yazilir. Bolunmenin sebebi: "anahtar paylasilmali" kurali MCP'den gelir, Google
# Cloud'dan degil. Platform degisirse bu dosya degisir, kural degismez.
#
# TUM REPLIKALAR bu tek sir surumunu okur. Onay akisinin cok replikali dagitimda
# ayakta kalmasinin tek sebebi budur.
# ═════════════════════════════════════════════════════════════════════════════

resource "google_secret_manager_secret" "state" {
  project   = var.project_id
  secret_id = "${var.name_prefix}-xurrent-state-secret"
  labels    = var.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

# ★ Bu, Terraform'un DEGERINI DE yazdigi TEK sirdir — cunku degeri Terraform
#   uretti. Digerleri (XURRENT_TOKEN, GEMINI_API_KEY) disaridan gelir ve
#   Terraform onlara HIC dokunmaz.
#
# TODO(saglayici surumu): google provider 6.14+ ile `secret_data_wo` (write-only)
# alani var; state'e deger yazilmasini engeller. Surum tabaniniz destekliyorsa
# ona gecin. Bugunku hali icin bkz. docs/15-dagitim.md § K7.
resource "google_secret_manager_secret_version" "state" {
  secret      = google_secret_manager_secret.state.id
  secret_data = var.state_secret_value
}

# ─────────────────────────────────────────────────────────────────────────────
# DISARIDAN GELEN SIRLAR
#
# Terraform yalnizca KABI olusturur. Degeri asla gormez, asla yazmaz, asla
# okumaz. Deger yoksa Cloud Run dagitimi BASARISIZ olur — bu istenen davranistir.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_secret_manager_secret" "xurrent_token" {
  count = local.create_token_secret ? 1 : 0

  project   = var.project_id
  secret_id = "${var.name_prefix}-xurrent-token"
  labels    = var.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "gemini_api_key" {
  count = local.create_gemini_secret ? 1 : 0

  project   = var.project_id
  secret_id = "${var.name_prefix}-gemini-api-key"
  labels    = var.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

locals {
  create_token_secret  = var.needs_xurrent_token && var.xurrent_token_secret_id == null
  create_gemini_secret = var.needs_gemini && var.gemini_api_key_secret_id == null

  token_secret_id  = !var.needs_xurrent_token ? null : (local.create_token_secret ? one(google_secret_manager_secret.xurrent_token[*].secret_id) : var.xurrent_token_secret_id)
  gemini_secret_id = !var.needs_gemini ? null : (local.create_gemini_secret ? one(google_secret_manager_secret.gemini_api_key[*].secret_id) : var.gemini_api_key_secret_id)

  # ORTAM DEGISKENI ADI → SIR KIMLIGI.
  # Konteynere hicbir sir DEGERI gecmez; yalnizca referans gecer. Deger okumasini
  # calisma aninda Cloud Run yapar.
  state_env  = { XURRENT_STATE_SECRET = google_secret_manager_secret.state.secret_id }
  token_env  = local.token_secret_id == null ? {} : { XURRENT_TOKEN = local.token_secret_id }
  gemini_env = local.gemini_secret_id == null ? {} : { GEMINI_API_KEY = local.gemini_secret_id }
  secret_env = merge(local.state_env, local.token_env, local.gemini_env)

  # Apply sonrasi operatorun ELLE doldurmasi gereken sirlar.
  secrets_to_fill = compact([
    local.create_token_secret ? "${var.name_prefix}-xurrent-token" : "",
    local.create_gemini_secret ? "${var.name_prefix}-gemini-api-key" : "",
  ])
}

# En dar yetki: yalnizca bu servisin kullandigi sirlar, yalnizca okuma.
resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = local.secret_env

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# ═════════════════════════════════════════════════════════════════════════════
# SERVIS
# ═════════════════════════════════════════════════════════════════════════════

resource "google_cloud_run_v2_service" "this" {
  project  = var.project_id
  location = var.region
  name     = var.name_prefix
  ingress  = var.ingress
  labels   = var.labels

  # TODO(karar): uretimde true yapin. Dev iskeletinde false, ki `terraform
  # destroy` ders sonunda calissin.
  deletion_protection = false

  template {
    service_account = google_service_account.runtime.email
    timeout         = "${var.request_timeout_seconds}s"

    max_instance_request_concurrency = var.max_concurrency

    # ★★★ STICKY SESSION GEREKMIYOR — ve bu bilincli bir iddiadir.
    #
    # MCP 2026-07-28 stateless'tir: MRTR'nin ikinci istegi BAGIMSIZ bir istektir,
    # yeni bir JSON-RPC id ile gelir ve ihtiyaci olan her seyi `requestState`
    # icinde tasir. Yani ikinci istegin ilkiyle AYNI replikaya dusmesi gerekmez.
    #
    # ★ Ama bu yalnizca imza anahtari PAYLASILDIGI icin dogrudur. Anahtar replika
    #   basina rastgele uretilseydi (XURRENT_STATE_SECRET bos birakilsaydi),
    #   ayni cumle YANLIS olurdu ve sticky session bir "cozum" gibi gorunurdu —
    #   aslinda sorunu gizleyen, replika olunce yine kirilan bir yama.
    session_affinity = false

    scaling {
      min_instance_count = var.min_replicas
      max_instance_count = var.max_replicas
    }

    containers {
      image = var.image

      ports {
        container_port = var.port
      }

      resources {
        limits = { cpu = var.cpu, memory = var.memory }
      }

      # Sir OLMAYAN degiskenler: degerleri dogrudan gomulur.
      dynamic "env" {
        for_each = var.plain_env
        content {
          name  = env.key
          value = env.value
        }
      }

      # ★ SIRLAR: yalnizca REFERANS gomulur. Deger ne Terraform plan'inda, ne
      #   servis tanimindaki ortam degiskeninde, ne de imajda gorunur.
      #
      # version = "latest": sir surumu degistiginde YENI bir revizyon gerekir.
      # TODO(karar): anahtar rotasyonunu otomatiklestirecekseniz sabit surum
      # numarasi + planli revizyon daha izlenebilirdir.
      dynamic "env" {
        for_each = local.secret_env
        content {
          name = env.key

          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      # ★ NEDEN HTTP DEGIL, TCP SONDASI:
      #
      # MCP HTTP tasiyicisinda SAGLIK UCU YOKTUR. Bilinen yollar yalnizca /mcp,
      # /mcp/v1 ve /mcp/v2'dir; diger her yol 404 doner
      # (servers/typescript/src/mcp/http.ts:133-145). Ustelik MCP_PROTOCOL="both"
      # iken /mcp'nin KENDISI de 404'tur (ayni dosya, satir 131).
      #
      # /mcp'ye HTTP sondasi kurmak iki turlu yanlis olurdu: GET bir JSON-RPC
      # istegi degildir, ve "both" modunda kasitli 404 saglikli bir sunucuyu
      # olu gosterirdi.
      #
      # TODO(karar): uc sunucuya da `GET /healthz` eklenirse sonda HTTP'ye
      # cevrilebilir ve "port acik ama uygulama kilitli" durumu da yakalanir.
      # Bkz. docs/15-dagitim.md § K11.
      startup_probe {
        tcp_socket {
          port = var.port
        }

        initial_delay_seconds = 5
        period_seconds        = 5
        timeout_seconds       = 3
        failure_threshold     = 6
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [google_project_service.required]
}

# ★★★ KIMLIK DOGRULAMASIZ ERISIM
#
# Varsayilan olarak OLUSTURULMAZ. Bu repodaki MCP HTTP tasiyicisinda hicbir
# kimlik dogrulama katmani yoktur (uc dilde de arandi, bulunamadi). allUsers'a
# invoker vermek, Xurrent hesabiniza yazabilen bir ucu internete acmaktir.
#
# Bkz. docs/15-dagitim.md § K4 — secenekler ve her birinin bedeli.
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  count = var.allow_unauthenticated ? 1 : 0

  project  = var.project_id
  location = google_cloud_run_v2_service.this.location
  name     = google_cloud_run_v2_service.this.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
