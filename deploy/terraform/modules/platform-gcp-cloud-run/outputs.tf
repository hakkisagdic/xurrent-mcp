output "service_url" {
  description = "Cloud Run servisinin taban adresi."
  value       = google_cloud_run_v2_service.this.uri
}

output "service_account_email" {
  description = "Calisma kimliginin e-posta adresi."
  value       = google_service_account.runtime.email
}

output "state_secret_id" {
  description = "XURRENT_STATE_SECRET'in Secret Manager kimligi."
  value       = google_secret_manager_secret.state.secret_id
}

output "secrets_to_fill" {
  description = "Apply sonrasi elle bir surum eklenmesi gereken sir kimlikleri."
  value       = local.secrets_to_fill
}
