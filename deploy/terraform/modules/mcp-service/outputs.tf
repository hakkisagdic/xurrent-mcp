# ★ BURADA SIR YOKTUR ve olmayacak.
#
# `random_password.state_secret.result` bilerek CIKTI VERILMEZ. Terraform state
# zaten onu duz metin tutar (bkz. envs/dev/backend.tf.example § uyari); ustune bir
# de output yapmak, `terraform output` calistiran herkesin ekranina dusurur ve CI
# loglarina sizmasini kolaylastirir. Deger gerekiyorsa sir deposundan okunur.

output "service_url" {
  description = "Servisin taban adresi."
  value       = one(module.gcp_cloud_run[*].service_url)
}

# server_mode = "web" iken MCP ucu yoktur; taban adres zaten sohbet arayuzudur.
# try(): platform modulu hic ornek uretmemisse (count = 0) null doner, hata degil.
output "mcp_endpoint" {
  description = "Istemcinin baglanacagi tam MCP adresi (yalnizca server_mode = \"http\")."
  value       = var.server_mode != "http" ? null : try("${one(module.gcp_cloud_run[*].service_url)}${local.mcp_path}", null)
}

output "service_account_email" {
  description = "Servisin calisma kimligi. Sir erisimleri bu kimlige verilir."
  value       = one(module.gcp_cloud_run[*].service_account_email)
}

output "state_secret_id" {
  description = "Uretilen XURRENT_STATE_SECRET'in sir deposundaki kimligi."
  value       = one(module.gcp_cloud_run[*].state_secret_id)
}

# ★ Operatorun ELLE doldurmasi gereken sirlar.
#
# Terraform bu sirlarin KABINI olusturur ama DEGERINI yazmaz — deger Terraform'a
# ugrasa state'e duz metin duserdi. Liste bos degilse: apply'dan sonra bu sirlara
# birer surum ekleyin, yoksa servis ayaga kalkmaz (fail-closed, istenen davranis).
output "secrets_to_fill" {
  description = "Apply sonrasi elle doldurulmasi gereken sir kimlikleri."
  value       = one(module.gcp_cloud_run[*].secrets_to_fill)
}

# Cok replikali dagitimda onay akisinin neden ayakta kaldigini TEK BAKISTA
# gosteren ozet. Ders acisindan degeri: "stateless" ile "hicbir state yok" ayni
# sey degildir — state vardir, imzalidir ve istemcide tasinir.
output "onay_akisi_ozeti" {
  description = "requestState'in cok replikali dagitimda neden calistiginin ozeti."
  value       = local.onay_akisi_ozeti
}
