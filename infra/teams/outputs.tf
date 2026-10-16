output "bot_app_id" {
  description = "The Entra application (client) id → TEAMS_APP_ID in the installation's .env"
  value       = azuread_application.bot.client_id
}

output "bot_tenant_id" {
  description = "→ TEAMS_APP_TENANT_ID"
  value       = var.tenant_id
}

output "bot_app_password" {
  description = "→ TEAMS_APP_PASSWORD (read with: terraform output -raw bot_app_password)"
  value       = azuread_application_password.bot.value
  sensitive   = true
}

output "teams_app_id" {
  description = "The Teams app (manifest) id — stable across package versions; publish.sh finds the catalog entry by it"
  value       = random_uuid.teams_app.result
}

output "package" {
  description = "The app package zip; upload with publish.sh"
  value       = data.archive_file.package.output_path
}
