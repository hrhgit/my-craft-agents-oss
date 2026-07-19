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

function Invoke-NpmCommandCapture {
	param(
		[Parameter(Mandatory = $true)]
		[string[]]$Arguments
	)

	$output = & $npmCommand.Source @Arguments
	$exitCode = $LASTEXITCODE
	if ($exitCode -ne 0) {
		exit $exitCode
	}

	return $output
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

function Invoke-NpmBuildInDirectory {
	param(
		[Parameter(Mandatory = $true)]
		[string]$Directory
	)

	Invoke-NpmCommandInDirectory -Directory $Directory -Arguments @("run", "build")
}

function New-TemporaryDirectory {
	$tempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-install-" + [System.Guid]::NewGuid().ToString("N"))
	$null = New-Item -ItemType Directory -Path $tempDirectory
	return $tempDirectory
}

function Invoke-NpmPackInDirectory {
	param(
		[Parameter(Mandatory = $true)]
		[string]$Directory,
		[Parameter(Mandatory = $true)]
		[string]$Destination
	)

	Push-Location (Join-Path $repoRoot $Directory)
	try {
		$output = Invoke-NpmCommandCapture -Arguments @("pack", "--json", "--pack-destination", $Destination)
		$packed = $output | ConvertFrom-Json
		if (-not $packed) {
			throw "Failed to pack npm package in $Directory."
		}
		if ($packed -is [System.Array]) {
			return Join-Path $Destination $packed[0].filename
		}
		return Join-Path $Destination $packed.filename
	} finally {
		Pop-Location
	}
}

$installCli = -not $WebOnly
$installWeb = $WebOnly
$cliPackages = @(
	"@mortise/pi-tui",
	"@mortise/pi-ai",
	"@mortise/pi-agent-core",
	"@mortise/pi-coding-agent"
)
$cliPackageDirectories = @(
	"packages/tui",
	"packages/ai",
	"packages/agent",
	"packages/coding-agent"
)
$localBuildDirectory = $null

Push-Location $repoRoot
try {
	if ($installCli) {
		$localBuildDirectory = New-TemporaryDirectory
		$tarballDirectory = Join-Path $localBuildDirectory "tarballs"
		$null = New-Item -ItemType Directory -Path $tarballDirectory

		Write-Host "Building local pi packages from the current workspace..."
		foreach ($directory in $cliPackageDirectories) {
			Invoke-NpmBuildInDirectory -Directory $directory
		}

		Write-Host "Packing local pi packages..."
		$cliTarballs = @()
		foreach ($directory in $cliPackageDirectories) {
			$cliTarballs += Invoke-NpmPackInDirectory -Directory $directory -Destination $tarballDirectory
		}

		Write-Host "Installing local pi packages globally..."
	}

	if ($installWeb) {
		Write-Host "Building pi-web launcher..."
		Invoke-NpmBuildInDirectory -Directory "packages/web-launcher"
	}

	if ($installCli) {
		Invoke-NpmCommand -Arguments (@("uninstall", "-g") + $cliPackages)
		Invoke-NpmCommand -Arguments (@("install", "-g") + $cliTarballs + @("--ignore-scripts"))
	}

	if ($installWeb) {
		Write-Host "Linking pi-web globally..."
		Invoke-NpmCommandInDirectory -Directory "packages/web-launcher" -Arguments @("link")
	}

	if ($installCli -and $installWeb) {
		Write-Host "pi has been installed from local workspace packages; pi-web has been built and linked globally."
		Write-Host "Open a new shell and run 'pi --version' and 'pi-web --help' to verify."
	} elseif ($installCli) {
		Write-Host "pi has been installed from local workspace packages."
		Write-Host "Open a new shell and run 'pi --version' to verify."
	} else {
		Write-Host "pi-web has been built and linked globally."
		Write-Host "Open a new shell and run 'pi-web --help' to verify."
	}
} finally {
	Pop-Location
	if ($localBuildDirectory -and (Test-Path $localBuildDirectory)) {
		Remove-Item -LiteralPath $localBuildDirectory -Recurse -Force
	}
}
