# Neden >= 1.9: bu modul degiskenler-arasi `validation` kullanir (bir degiskenin
# validation blogu baska bir degiskene bakar). Bu yetenek Terraform 1.9 ile geldi.
# Ornek: xurrent_mode = "live" ise xurrent_token_secret_id ZORUNLU olur.
# 1.9 oncesi surumlerde bu kurallar sessizce degil, ACIK bir hata ile duser.
terraform {
  required_version = ">= 1.9.0"

  required_providers {
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6"
    }
  }
}
