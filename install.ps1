# Hermes Bots, one command. Run this in PowerShell:
#
#   irm https://raw.githubusercontent.com/nexurlabs/hermes-bots/main/install.ps1 | iex
#
# Installs the latest Hermes Bots release, and Nous Research's Hermes first if it isn't on this PC yet.
# Switches, all optional, set as environment variables so they also work with `irm | iex`:
#   HERMES_BOTS_TARGET=pc|vps      skip the question: pc = this computer, vps = the app only
#   HERMES_BOTS_INSTALLER=<file>   install this installer file instead of the latest release (not checksummed)
#   HERMES_BOTS_DRY_RUN=1          print what would happen and change nothing

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 can default to older TLS; GitHub needs TLS 1.2.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
# The progress bar makes Invoke-WebRequest very slow on a download this size.
$ProgressPreference = 'SilentlyContinue'

$Repo = 'nexurlabs/hermes-bots'
$HermesInstallerUrl = 'https://hermes-agent.nousresearch.com/install.ps1'
$AppDir = Join-Path $env:LOCALAPPDATA 'Programs\Hermes Bots'
$AppExe = Join-Path $AppDir 'Hermes Bots.exe'
# The same file the app starts Hermes from (electron/main.cjs, hermesCommand).
$HermesExe = Join-Path $env:LOCALAPPDATA 'hermes\bin\hermes.exe'
$DryRun = $env:HERMES_BOTS_DRY_RUN -eq '1'

function Step($text) {
  Write-Host "==> $text"
}

function Test-Checksum($File, $SumText) {
  # Refuses an installer whose SHA-256 doesn't match the checksum published with the release.
  $expected = ($SumText.Trim() -split '\s+')[0].ToUpperInvariant()
  $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash
  if ($actual -ne $expected) {
    throw "The download doesn't match its published checksum (expected $expected, got $actual). Nothing was installed."
  }
}

function Get-LatestInstaller {
  Step 'Looking up the latest Hermes Bots release'
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'hermes-bots-install' }
  $asset = $release.assets | Where-Object { $_.name -match '^Hermes-Bots-Setup-.+\.exe$' } | Select-Object -First 1
  if (-not $asset) {
    throw "The latest release ($($release.tag_name)) has no Windows installer."
  }
  $sum = $release.assets | Where-Object { $_.name -eq "$($asset.name).sha256" } | Select-Object -First 1
  if (-not $sum) {
    throw "The latest release ($($release.tag_name)) has no checksum for $($asset.name), so it won't be installed."
  }

  $file = Join-Path $env:TEMP $asset.name
  Step "Downloading $($asset.name)"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -UseBasicParsing
  $sumText = (Invoke-WebRequest -Uri $sum.browser_download_url -UseBasicParsing).Content
  Test-Checksum $file $sumText
  return $file
}

function Install-HermesBots {
  Write-Host 'Hermes Bots, one-command install'
  if ($env:OS -ne 'Windows_NT') {
    throw 'This installer is for Windows.'
  }

  $target = $env:HERMES_BOTS_TARGET
  if (-not $target) {
    $target = 'pc'
    if ([Environment]::UserInteractive) {
      $answer = Read-Host 'Set up on this PC (1) or on a VPS (2)? [1]'
      if ($answer -eq '2') { $target = 'vps' }
    }
  }
  if ($target -notin @('pc', 'vps')) {
    throw "HERMES_BOTS_TARGET must be pc or vps, not '$target'."
  }

  if (Get-Process -Name 'Hermes Bots' -ErrorAction SilentlyContinue) {
    throw 'Hermes Bots is open. Close it first, then run this again.'
  }

  $installer = $env:HERMES_BOTS_INSTALLER

  if ($DryRun) {
    Step "Would install from $(if ($installer) { $installer } else { 'the latest GitHub release, after its checksum matches' })"
    if ($target -eq 'pc' -and -not (Test-Path -LiteralPath $HermesExe)) { Step "Would install Hermes from $HermesInstallerUrl" }
    Step "Would install Hermes Bots silently into $AppDir"
    Step 'Would open Hermes Bots'
    return
  }

  if ($installer) {
    if (-not (Test-Path -LiteralPath $installer)) { throw "No installer at $installer." }
    Step "Using $installer (its checksum isn't checked)"
  } else {
    $installer = Get-LatestInstaller
  }

  if ($target -eq 'pc') {
    if (Test-Path -LiteralPath $HermesExe) {
      Step 'Hermes is already installed'
    } else {
      Step 'Installing Hermes (Nous Research installer)'
      Invoke-RestMethod -Uri $HermesInstallerUrl | Invoke-Expression
      if (-not (Test-Path -LiteralPath $HermesExe)) {
        throw 'Hermes did not install. Read the messages above, then run this again.'
      }
    }
  }

  Step 'Installing Hermes Bots'
  $setup = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  if ($setup.ExitCode -ne 0) {
    throw "The Hermes Bots installer failed (exit code $($setup.ExitCode))."
  }
  if (-not (Test-Path -LiteralPath $AppExe)) {
    throw "The installer finished, but $AppExe is missing."
  }

  Step 'Opening Hermes Bots'
  Start-Process -FilePath $AppExe
  if ($target -eq 'pc') {
    Write-Host 'Done. Choose "This computer" and click Connect.'
  } else {
    Write-Host 'Done. Open Settings > Machines and add your VPS over SSH.'
  }
}

# HERMES_BOTS_NO_RUN lets a test load the functions above without running the install.
if (-not $env:HERMES_BOTS_NO_RUN) {
  Install-HermesBots
}
