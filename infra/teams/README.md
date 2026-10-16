# infra/teams — a Teams installation's bot identity, as a Terraform module

What a Teams installation of CoachAven needs on the Microsoft side, created from one variables
file: a **single-tenant Entra application** with a client secret (rotated yearly by `apply`), an
**Azure Bot** (F0, free) bound to that app and to the installation's messaging endpoint, the
**Teams channel** on it, and the **Teams app package** (manifest + icons, zipped) that
`publish.sh` uploads to the organization's app catalog. The driver itself is OpenSpec
`teams-chat-driver`.

This directory is a **module**: no provider blocks, no identifiers. Your ops repo holds the root
that calls it, the variables and the state (the state contains the secret — it stays on the
operator's machine, ignored by the ops repo's `.gitignore`).

## A root in your ops repo (`infra/<slug>/teams/`)

```hcl
# main.tf
terraform {
  required_providers {
    azuread = { source = "hashicorp/azuread", version = "~> 3.0" }
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
  }
}
provider "azuread" { tenant_id = var.tenant_id }
provider "azurerm" {
  features {}
  tenant_id       = var.tenant_id
  subscription_id = var.subscription_id
}
variable "tenant_id" { type = string }
variable "subscription_id" { type = string }
variable "messaging_endpoint" { type = string }
variable "app_version" { type = string, default = "1.0.0" }

module "teams" {
  source             = "../../teams"
  tenant_id          = var.tenant_id
  subscription_id    = var.subscription_id
  bot_name           = "<globally unique bot handle>"
  display_name       = "Aven"
  developer_name     = "<your company>"
  website_url        = "https://<your site>"
  messaging_endpoint = var.messaging_endpoint
  app_version        = var.app_version
}
output "bot_app_id"       { value = module.teams.bot_app_id }
output "bot_tenant_id"    { value = module.teams.bot_tenant_id }
output "bot_app_password" { value = module.teams.bot_app_password, sensitive = true }
output "teams_app_id"     { value = module.teams.teams_app_id }
output "package"          { value = module.teams.package }
```

```
# terraform.tfvars — the installation's identifiers (fine in the private ops repo)
tenant_id          = "<entra tenant id>"
subscription_id    = "<azure subscription id>"
messaging_endpoint = "https://<bot host>/api/messages"
```

Auth is the operator's `az login` (a user with rights to create app registrations and the
resource group); Terraform itself gets no service principal.

```bash
az login --tenant <tenant id>
terraform -chdir=infra/<slug>/teams init && terraform -chdir=infra/<slug>/teams apply
infra/teams/publish.sh infra/<slug>/teams                 # upload / update the package in the org catalog
terraform -chdir=infra/<slug>/teams output -raw bot_app_password   # → TEAMS_APP_PASSWORD in the installation's .env
```

## Day 2

- **Endpoint moves** (new host, tunnel): change `messaging_endpoint`, `apply` — only the Azure
  Bot changes; app id, secret and Teams app id stay.
- **Manifest change**: bump `app_version`, `apply`, `publish.sh` — Teams refuses a re-upload
  with the same version. The Teams app id is kept in state, so users keep their installation.
- **Secret rotation**: `apply` after a year mints a new secret (the old stays valid until that
  apply); copy it into `.env`, restart the service.
- **Icons**: the module ships neutral placeholders; set `icon_color_path` / `icon_outline_path`
  to your own PNGs (192×192 colour, 32×32 transparent white outline). Two bots in one tenant
  must differ here.
- **State lost**: everything is re-creatable — `terraform import` the four objects (app,
  service principal, resource group, bot), or delete the resource group and the app and apply
  again (then the Teams app id changes and users re-add the app).

## What the manifest declares

Bot scopes `personal`, `team`, `groupChat`; resource-specific permissions
`ChannelMessage.Read.Group` and `ChatMessage.Read.Chat`, so the bot receives thread replies
without an @mention (Slack parity) — the team or chat owner consents when installing the app.
`supportsFiles` is off until the driver spec decides files. Catalog upload needs **custom app
upload** allowed in the tenant's Teams app setup policy and a Teams licence on the admin.
