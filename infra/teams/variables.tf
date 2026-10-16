# Every identifier of an installation is a variable: this module ships in the public repo and
# must name no tenant, subscription, host or product owner. Values live in the ops repo's
# terraform.tfvars (infra/<slug>/teams/).

variable "tenant_id" {
  description = "Entra tenant that hosts the bot. Single-tenant by design: guests from other tenants join THIS one."
  type        = string
}

variable "subscription_id" {
  description = "Azure subscription for the Bot Service resource (F0 = free tier)."
  type        = string
}

variable "location" {
  description = "Region of the resource group (the bot resource itself is always \"global\")."
  type        = string
  default     = "westeurope"
}

variable "resource_group_name" {
  description = "Resource group that holds the Azure Bot."
  type        = string
  default     = "coach-aven-teams"
}

variable "bot_name" {
  description = "Azure Bot resource name — globally unique across Azure, becomes the bot handle."
  type        = string
}

variable "display_name" {
  description = "What people see in Teams: the bot's and the app's short name."
  type        = string
  default     = "Aven"
}

variable "developer_name" {
  description = "Manifest developer.name — the operator (shown on the app's About page)."
  type        = string
}

variable "website_url" {
  description = "Manifest developer.websiteUrl; also used for privacy and terms unless given."
  type        = string
}

variable "privacy_url" {
  type    = string
  default = null
}

variable "terms_url" {
  type    = string
  default = null
}

variable "messaging_endpoint" {
  description = "Public HTTPS URL Teams POSTs activities to (…/api/messages). Changing it updates the Azure Bot only."
  type        = string
}

variable "app_version" {
  description = "Teams app package version — bump on every manifest change; Teams refuses a re-upload with the same version."
  type        = string
  default     = "1.0.0"
}

variable "icon_color_path" {
  description = "192×192 PNG for the app's colour icon. Default: the neutral placeholder in icons/. Two bots in one tenant should differ here."
  type        = string
  default     = null
}

variable "icon_outline_path" {
  description = "32×32 transparent white PNG for the outline icon. Default: the placeholder in icons/."
  type        = string
  default     = null
}

variable "build_dir" {
  description = "Where the rendered manifest and the zip go (the calling root's directory by default; ignored by the ops repo's .gitignore when under build/)."
  type        = string
  default     = null
}
