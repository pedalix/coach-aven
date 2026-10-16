# A Teams installation's bot identity, end to end except the catalog upload:
#   Entra app (single-tenant — multi-tenant bot creation ended in 2025, and guests join the
#   host tenant anyway) → Azure Bot (F0) → Teams channel → the app package zip (manifest +
#   icons) that publish.sh uploads to the organization's catalog.
# Everything is re-creatable from the same inputs; the one value that must stay stable across
# package versions is the Teams app id, which lives in state (random_uuid).

data "azuread_client_config" "me" {}

locals {
  build_dir    = coalesce(var.build_dir, "${path.root}/build")
  icon_color   = coalesce(var.icon_color_path, "${path.module}/icons/color.png")
  icon_outline = coalesce(var.icon_outline_path, "${path.module}/icons/outline.png")
  privacy_url  = coalesce(var.privacy_url, var.website_url)
  terms_url    = coalesce(var.terms_url, var.website_url)
  package_name = "${var.bot_name}-${var.app_version}.zip"
}

resource "azuread_application" "bot" {
  display_name     = "${var.display_name} (Teams bot)"
  sign_in_audience = "AzureADMyOrg"
  owners           = [data.azuread_client_config.me.object_id]

  # Channel documents are SharePoint links the bot reads through Graph (driver files.ts):
  # Files.Read.All as an application permission, granted by an admin's consent after apply.
  dynamic "required_resource_access" {
    for_each = var.supports_files ? [1] : []
    content {
      resource_app_id = "00000003-0000-0000-c000-000000000000" # Microsoft Graph
      resource_access {
        id   = "01d4889c-1287-42c6-ac1f-5d1e02578ef6" # Files.Read.All (application)
        type = "Role"
      }
    }
  }
}

resource "azuread_service_principal" "bot" {
  client_id = azuread_application.bot.client_id
  owners    = [data.azuread_client_config.me.object_id]
}

# Yearly rotation: an apply after the year mints a new secret (the old one stays valid until
# then); the operator copies the new value into the installation's .env and restarts.
resource "time_rotating" "secret" {
  rotation_days = 365
}

resource "azuread_application_password" "bot" {
  application_id = azuread_application.bot.id
  display_name   = "coach-aven teams driver"
  end_date       = time_rotating.secret.rotation_rfc3339
  rotate_when_changed = {
    rotation = time_rotating.secret.id
  }
}

resource "azurerm_resource_group" "teams" {
  name     = var.resource_group_name
  location = var.location
}

resource "azurerm_bot_service_azure_bot" "bot" {
  name                    = var.bot_name
  resource_group_name     = azurerm_resource_group.teams.name
  location                = "global"
  sku                     = "F0"
  display_name            = var.display_name
  endpoint                = var.messaging_endpoint
  microsoft_app_id        = azuread_application.bot.client_id
  microsoft_app_type      = "SingleTenant"
  microsoft_app_tenant_id = var.tenant_id
}

resource "azurerm_bot_channel_ms_teams" "bot" {
  bot_name            = azurerm_bot_service_azure_bot.bot.name
  location            = azurerm_bot_service_azure_bot.bot.location
  resource_group_name = azurerm_resource_group.teams.name
}

# The Teams app id is ours to pick and must survive version bumps — kept in state.
resource "random_uuid" "teams_app" {}

# Package dir: manifest rendered from state, icons copied verbatim; the zip is built from it.
resource "local_file" "manifest" {
  filename = "${local.build_dir}/pkg/manifest.json"
  content = templatefile("${path.module}/manifest.json.tftpl", {
    app_id         = random_uuid.teams_app.result
    bot_id         = azuread_application.bot.client_id
    version        = var.app_version
    display_name   = var.display_name
    supports_files = var.supports_files
    developer_name = var.developer_name
    website_url    = var.website_url
    privacy_url    = local.privacy_url
    terms_url      = local.terms_url
  })
}

resource "local_file" "icon" {
  for_each       = { "color.png" = local.icon_color, "outline.png" = local.icon_outline }
  filename       = "${local.build_dir}/pkg/${each.key}"
  content_base64 = filebase64(each.value)
}

data "archive_file" "package" {
  type        = "zip"
  source_dir  = "${local.build_dir}/pkg"
  output_path = "${local.build_dir}/${local.package_name}"
  depends_on  = [local_file.manifest, local_file.icon]
}
