# ─────────────────────────────────────────────────────────────────────────────
# PLATFORM MODULU — Google Cloud Run
#
# Bu modul, modules/mcp-service arayuzunun TEK somut implementasyonudur ve
# saglayiciya bagimli olan HER SEY buradadir. Ust modul "ne" istendigini bilir;
# bu modul "nasil" yapildigini.
#
# ★ Bu modul UYGULAMA SEMANTIGINI BILMEZ. "live mi mock mu", "sohbet mi MCP mi"
#   sorularinin cevabini almaz — yalnizca "su sir gerekli mi" (needs_*) ve
#   "su ortam degiskenlerini bagla" (plain_env) girdilerini alir. Sinir bilerek
#   boyle cizildi: ikinci bir platform yazildiginda ayni girdilerle yetinsin.
# ─────────────────────────────────────────────────────────────────────────────

variable "project_id" {
  description = "GCP proje kimligi."
  type        = string
}

variable "region" {
  description = "Cloud Run bolgesi."
  type        = string
}

variable "name_prefix" {
  description = "Kaynak ad oneki."
  type        = string
}

variable "labels" {
  description = "Kaynak etiketleri."
  type        = map(string)
  default     = {}
}

variable "enable_apis" {
  description = "run.googleapis.com ve secretmanager.googleapis.com etkinlestirilsin mi?"
  type        = bool
  default     = false
}

variable "image" {
  description = "Konteyner imaji."
  type        = string
}

variable "port" {
  description = "Konteynerin dinledigi port."
  type        = number
}

variable "plain_env" {
  description = "Sir OLMAYAN ortam degiskenleri."
  type        = map(string)
  default     = {}
}

variable "min_replicas" {
  description = "En az ornek sayisi."
  type        = number
}

variable "max_replicas" {
  description = "En cok ornek sayisi."
  type        = number
}

variable "max_concurrency" {
  description = "Ornek basina es zamanli istek."
  type        = number
}

variable "cpu" {
  description = "Ornek basina CPU."
  type        = string
}

variable "memory" {
  description = "Ornek basina bellek."
  type        = string
}

variable "request_timeout_seconds" {
  description = "Istek zaman asimi (saniye)."
  type        = number
}

variable "allow_unauthenticated" {
  description = "allUsers'a run.invoker verilsin mi? Bkz. docs/15-dagitim.md § K4."
  type        = bool
}

variable "ingress" {
  description = "Cloud Run ingress politikasi."
  type        = string
}

# ★ Bu deger SIRDIR ve `sensitive = true` ile isaretlidir: plan/apply ciktisinda
#   gorunmez. Yine de Terraform STATE'inde duz metin durur — bu Terraform'un
#   yapisal bir gercegidir, bir kusur degil. Sonucu: state dosyasi da bir sirdir.
#   Bkz. envs/dev/backend.tf.example ve docs/15-dagitim.md § K7.
variable "state_secret_value" {
  description = "Uretilmis XURRENT_STATE_SECRET degeri."
  type        = string
  sensitive   = true
}

variable "needs_xurrent_token" {
  description = "XURRENT_TOKEN sirri baglanacak mi?"
  type        = bool
}

variable "xurrent_token_secret_id" {
  description = "Var olan XURRENT_TOKEN sirrinin kimligi. null ise bos kap olusturulur."
  type        = string
  default     = null
}

variable "needs_gemini" {
  description = "GEMINI_API_KEY sirri baglanacak mi?"
  type        = bool
}

variable "gemini_api_key_secret_id" {
  description = "Var olan GEMINI_API_KEY sirrinin kimligi. null ise bos kap olusturulur."
  type        = string
  default     = null
}
