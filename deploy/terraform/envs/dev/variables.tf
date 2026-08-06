# ─────────────────────────────────────────────────────────────────────────────
# ORNEK ORTAM — dev
#
# ★ Bu dosyada TEK BIR SIR YOKTUR ve olmamalidir. XURRENT_TOKEN ve GEMINI_API_KEY
#   burada DEGER olarak degil, sir deposundaki KIMLIK olarak gecer.
#   XURRENT_STATE_SECRET ise hic gecmez: onu Terraform uretir.
# ─────────────────────────────────────────────────────────────────────────────

variable "gcp_project_id" {
  description = "GCP proje kimligi. Uydurma bir deger YOKTUR; siz doldurun."
  type        = string
}

variable "gcp_region" {
  description = "Cloud Run bolgesi. Veri ikameti karari icin bkz. docs/15-dagitim.md § K9."
  type        = string
}

variable "name_prefix" {
  description = "Kaynak ad oneki."
  type        = string
  default     = "xurrent-mcp-dev"
}

# ★ Bu repoda Dockerfile YOKTUR ve bu degiskenin varsayilani da yoktur.
#   Imaji kim uretiyor sorusu bir karardir: docs/15-dagitim.md § K8.
variable "image" {
  description = "Konteyner imaji (tercihen digest ile sabitlenmis)."
  type        = string
}

variable "min_replicas" {
  description = "En az ornek sayisi."
  type        = number
  default     = 0
}

variable "max_replicas" {
  description = "En cok ornek sayisi."
  type        = number
  default     = 3
}

# dev ortaminda varsayilan bilerek "mock": ders repo'sunun dagitilmis hali de
# once hicbir sey kirmadan ayaga kalksin.
variable "xurrent_mode" {
  description = "\"mock\" veya \"live\"."
  type        = string
  default     = "mock"
}

variable "xurrent_dry_run" {
  description = "true iken hicbir mutation gonderilmez."
  type        = bool
  default     = true
}

variable "xurrent_account" {
  description = "X-Xurrent-Account slug'i. Sir DEGILDIR."
  type        = string
  default     = ""
}

# null → Terraform bos bir sir kabi olusturur, degeri siz yazarsiniz.
variable "xurrent_token_secret_id" {
  description = "Var olan XURRENT_TOKEN sirrinin kimligi."
  type        = string
  default     = null
}

variable "gemini_api_key_secret_id" {
  description = "Var olan GEMINI_API_KEY sirrinin kimligi."
  type        = string
  default     = null
}

variable "server_mode" {
  description = "\"http\" (MCP) veya \"web\" (sohbet arayuzu)."
  type        = string
  default     = "http"
}

variable "allow_unauthenticated" {
  description = "★ TEHLIKELI. Bkz. docs/15-dagitim.md § K4."
  type        = bool
  default     = false
}

variable "labels" {
  description = "Kaynak etiketleri."
  type        = map(string)
  default     = {}
}
