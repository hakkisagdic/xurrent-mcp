terraform {
  required_version = ">= 1.9.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6"
    }
  }
}

# ★ Saglayici yapilandirmasi KOK MODULDE durur, modullerde degil.
#
# Modul icinde `provider` blogu tanimlamak, o modulu baska bir hesapta ya da
# baska kimlik bilgileriyle kullanilamaz hale getirir. Kimlik bilgisi buraya
# YAZILMAZ: gcloud ADC ya da GOOGLE_APPLICATION_CREDENTIALS uzerinden gelir.
provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}
