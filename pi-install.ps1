$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path $scriptDir).Path
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue

if (-not $npmCommand) {
	$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
}

if (-not $npmCommand) {
	throw "npm not found. Install Node.js and npm first."
}

Push-Location $repoRoot
try {
	Write-Host "Building pi..."
	& $npmCommand.Source run build
	$exitCode = $LASTEXITCODE
	if ($exitCode -ne 0) {
		exit $exitCode
	}

	Write-Host "Linking pi globally..."
	& $npmCommand.Source --prefix packages/coding-agent link
	$exitCode = $LASTEXITCODE
	if ($exitCode -ne 0) {
		exit $exitCode
	}

	Write-Host "pi has been built and linked globally."
	Write-Host "Open a new shell and run 'pi --version' to verify."
} finally {
	Pop-Location
}
