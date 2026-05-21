$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installScript = Join-Path $scriptDir "pi-install.ps1"

if (-not (Test-Path $installScript)) {
	throw "pi-install.ps1 not found next to pi-web-install.ps1."
}

& $installScript -WebOnly
exit $LASTEXITCODE
