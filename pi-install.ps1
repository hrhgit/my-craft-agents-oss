[CmdletBinding()]
param(
	[switch]$CliOnly,
	[switch]$WebOnly
)

$ErrorActionPreference = "Stop"

if ($CliOnly -and $WebOnly) {
	throw "Choose either -CliOnly or -WebOnly, not both."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path $scriptDir).Path
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue

if (-not $npmCommand) {
	$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
}

if (-not $npmCommand) {
	throw "npm not found. Install Node.js and npm first."
}

function Invoke-NpmCommand {
	param(
		[Parameter(Mandatory = $true)]
		[string[]]$Arguments
	)

	& $npmCommand.Source @Arguments
	$exitCode = $LASTEXITCODE
	if ($exitCode -ne 0) {
		exit $exitCode
	}
}

function Invoke-NpmCommandInDirectory {
	param(
		[Parameter(Mandatory = $true)]
		[string]$Directory,
		[Parameter(Mandatory = $true)]
		[string[]]$Arguments
	)

	Push-Location (Join-Path $repoRoot $Directory)
	try {
		Invoke-NpmCommand -Arguments $Arguments
	} finally {
		Pop-Location
	}
}

$installCli = -not $WebOnly
$installWeb = -not $CliOnly

Push-Location $repoRoot
try {
	Write-Host "Building pi packages..."
	Invoke-NpmCommand -Arguments @("run", "build")

	if ($installCli) {
		Write-Host "Linking pi globally..."
		Invoke-NpmCommandInDirectory -Directory "packages/coding-agent" -Arguments @("link")
	}

	if ($installWeb) {
		Write-Host "Linking pi-web globally..."
		Invoke-NpmCommandInDirectory -Directory "packages/web-launcher" -Arguments @("link")
	}

	if ($installCli -and $installWeb) {
		Write-Host "pi and pi-web have been built and linked globally."
		Write-Host "Open a new shell and run 'pi --version' and 'pi-web --help' to verify."
	} elseif ($installCli) {
		Write-Host "pi has been built and linked globally."
		Write-Host "Open a new shell and run 'pi --version' to verify."
	} else {
		Write-Host "pi-web has been built and linked globally."
		Write-Host "Open a new shell and run 'pi-web --help' to verify."
	}
} finally {
	Pop-Location
}
