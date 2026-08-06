# ─────────────────────────────────────────────────────────────────────────────
# ORNEK ORTAM
#
# Ortam dosyasinin isi ince olmalidir: DEGER secer, MANTIK kurmaz. Mantik
# modules/mcp-service icindedir. Yeni bir ortam (staging, prod) acmak, bu
# klasoru kopyalayip degerleri degistirmektir.
# ─────────────────────────────────────────────────────────────────────────────

module "mcp" {
  source = "../../modules/mcp-service"

  platform       = "gcp-cloud-run"
  gcp_project_id = var.gcp_project_id
  gcp_region     = var.gcp_region
  name_prefix    = var.name_prefix
  labels         = var.labels

  image       = var.image
  server_mode = var.server_mode
  port        = 8788

  # ★ min = 0, max = 3 → cok replikali VE sifira olceklenen bir kurulum.
  #   Ikisi de requestState'i etkiler ve ikisi de bu iskelette bilinerek acik:
  #   - cok replika  → imza anahtari PAYLASILIYOR (modul bunu garanti eder)
  #   - sifira olcek → nonce seti kayboluyor (TTL kadar replay penceresi)
  #   Ayrinti: docs/15-dagitim.md § "Sabit sirrin bedeli".
  min_replicas = var.min_replicas
  max_replicas = var.max_replicas

  xurrent_mode        = var.xurrent_mode
  xurrent_dry_run     = var.xurrent_dry_run
  xurrent_account     = var.xurrent_account
  mcp_protocol        = "2026-07-28"
  confirm_policy      = "closed"
  calendar_provider   = "mock"
  state_ttl_seconds   = 300
  timezone            = "Europe/Istanbul"
  xurrent_graphql_url = "https://graphql.xurrent.com"

  # Sirlarin DEGERI degil, KIMLIGI. null ise Terraform bos kap acar.
  xurrent_token_secret_id  = var.xurrent_token_secret_id
  gemini_api_key_secret_id = var.gemini_api_key_secret_id

  allow_unauthenticated = var.allow_unauthenticated
}
