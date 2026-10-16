# A MODULE: no provider blocks here. The calling root (in an installation's ops repo,
# infra/<slug>/teams/) configures azuread + azurerm and holds the state — see README.md.
terraform {
  required_version = ">= 1.6"
  required_providers {
    azuread = { source = "hashicorp/azuread", version = "~> 3.0" }
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
    time    = { source = "hashicorp/time", version = "~> 0.12" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
    archive = { source = "hashicorp/archive", version = "~> 2.6" }
    local   = { source = "hashicorp/local", version = "~> 2.5" }
  }
}
