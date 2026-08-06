output "service_url" {
  description = "Servisin taban adresi."
  value       = module.mcp.service_url
}

output "mcp_endpoint" {
  description = "Istemcinin baglanacagi tam MCP adresi."
  value       = module.mcp.mcp_endpoint
}

output "state_secret_id" {
  description = "Uretilen XURRENT_STATE_SECRET'in sir deposundaki kimligi. DEGER DEGIL, KIMLIK."
  value       = module.mcp.state_secret_id
}

# Bos degilse: apply bitti ama servis HENUZ CALISMAZ. Listedeki sirlara birer
# surum ekleyin. Bu, unutuldugunda sessizce degil ACIKCA kirilan bir adimdir.
output "secrets_to_fill" {
  description = "Elle doldurulmasi gereken sir kimlikleri."
  value       = module.mcp.secrets_to_fill
}

output "onay_akisi_ozeti" {
  description = "requestState'in bu kurulumda neden calistigi."
  value       = module.mcp.onay_akisi_ozeti
}
