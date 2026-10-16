#!/usr/bin/env bash
# Upload (first time) or update a Teams installation's app package in its organization's
# catalog. Terraform (this module, applied from the ops repo's root) builds the zip; the
# catalog has no Terraform provider and the Azure CLI's Graph token lacks AppCatalog.*, so the
# upload goes through the MicrosoftTeams PowerShell module with a device-code login as a Teams
# administrator. Nothing is stored.
#
#   infra/teams/publish.sh infra/<slug>/teams      # the root directory you ran `terraform apply` in
set -euo pipefail
root="${1:?usage: publish.sh <terraform root dir, e.g. infra/<slug>/teams>}"
command -v pwsh >/dev/null || { echo "pwsh not found — PowerShell 7 + Install-Module MicrosoftTeams" >&2; exit 1; }
pkg=$(terraform -chdir="$root" output -raw package)
[[ "$pkg" = /* ]] || pkg="$root/$pkg"   # the module builds under path.root → relative to the root dir
ext=$(terraform -chdir="$root" output -raw teams_app_id)
tenant=$(terraform -chdir="$root" output -raw bot_tenant_id)
[[ -f "$pkg" ]] || { echo "no package at $pkg — run terraform apply in $root first" >&2; exit 1; }
pwsh -NoLogo -Command "
  Import-Module MicrosoftTeams
  Connect-MicrosoftTeams -UseDeviceAuthentication -TenantId '$tenant' | Out-Null
  \$app = Get-TeamsApp -ExternalId '$ext'
  if (\$app) { Set-TeamsApp -AppId \$app.Id -Path '$pkg'; 'updated ' + \$app.Id }
  else { 'created ' + (New-TeamsApp -DistributionMethod organization -Path '$pkg').Id }
"
