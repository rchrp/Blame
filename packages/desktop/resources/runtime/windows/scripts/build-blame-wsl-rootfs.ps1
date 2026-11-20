param(
  [string]$UbuntuRootfs = "",
  [string]$Output = "",
  [string]$RuntimeVersion = "",
  [string]$DistroName = "BlameRuntimeBuild",
  [switch]$KeepDistro,
  [switch]$Replace,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

function Write-Usage {
  @"
Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File build-blame-wsl-rootfs.ps1 -UbuntuRootfs <path> -Output <path> -RuntimeVersion <version> [-KeepDistro] [-Replace]

Options:
  -UbuntuRootfs     Ubuntu WSL rootfs tar or tar.gz to import.
  -Output           Output rootfs tar or tar.gz path.
  -RuntimeVersion   Blame runtime version written by the provisioner.
  -KeepDistro       Keep the temporary WSL distro after export.
  -Replace          Unregister an existing temporary distro with the same name.
"@
}

function Assert-Inputs {
  if ($Help) {
    Write-Usage
    exit 0
  }
  if (-not $UbuntuRootfs -or -not $Output -or -not $RuntimeVersion) {
    Write-Usage
    exit 2
  }
  if (-not (Test-Path $UbuntuRootfs)) {
    throw "Ubuntu rootfs does not exist: $UbuntuRootfs"
  }
}

function Invoke-WslHost {
  param([string[]]$WslArgs)
  $output = & wsl.exe @WslArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ($output -join "`n")
  }
  $output
}

function Test-DistroPresent {
  $output = & wsl.exe --list --quiet 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ($output -join "`n")
  }
  ($output -replace "`0", "") -split "`n" | Where-Object { $_.Trim() -eq $DistroName } | Select-Object -First 1
}

function Invoke-Distro {
  param([string]$Command)
  Invoke-WslHost -WslArgs @("-d", $DistroName, "-u", "root", "--", "sh", "-lc", $Command) | Out-Null
}

function Invoke-Provisioner {
  $script = Join-Path $PSScriptRoot "provision-blame-runtime.sh"
  $content = Get-Content $script -Raw
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo.FileName = "wsl.exe"
  $process.StartInfo.Arguments = Join-Arguments @("-d", $DistroName, "-u", "root", "--", "sh", "-s", "--", $RuntimeVersion)
  $process.StartInfo.RedirectStandardInput = $true
  $process.StartInfo.RedirectStandardOutput = $false
  $process.StartInfo.RedirectStandardError = $false
  $process.StartInfo.UseShellExecute = $false
  $process.Start() | Out-Null
  $process.StandardInput.Write($content)
  $process.StandardInput.Close()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) {
    throw "BlameRuntime rootfs provisioning failed."
  }
}

function Join-Arguments {
  param([string[]]$Items)
  ($Items | ForEach-Object { Quote-Argument $_ }) -join " "
}

function Quote-Argument {
  param([string]$Value)
  if ($Value -notmatch '[\s"]') {
    return $Value
  }
  '"' + ($Value -replace '"', '\"') + '"'
}

function Initialize-Distro {
  if (Test-DistroPresent) {
    if (-not $Replace) {
      throw "WSL distro already exists: $DistroName. Use -Replace or choose another -DistroName."
    }
    Invoke-WslHost -WslArgs @("--unregister", $DistroName) | Out-Null
  }
  $installRoot = Join-Path ([System.IO.Path]::GetTempPath()) "$DistroName-$([guid]::NewGuid().ToString("N"))"
  New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
  Invoke-WslHost -WslArgs @("--import", $DistroName, $installRoot, (Resolve-Path $UbuntuRootfs).Path, "--version", "2") | Out-Null
  $installRoot
}

function Optimize-Distro {
  Invoke-Distro "apt-get clean >/dev/null 2>&1 || true; rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*; npm cache clean --force >/dev/null 2>&1 || true"
}

function Export-Distro {
  $outputPath = [System.IO.Path]::GetFullPath($Output)
  $outputDirectory = Split-Path -Parent $outputPath
  if (-not $outputDirectory) {
    $outputDirectory = (Get-Location).Path
  }
  New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
  $exportPath = $outputPath
  $gzipOutput = $outputPath.EndsWith(".gz", [System.StringComparison]::OrdinalIgnoreCase)
  if ($gzipOutput) {
    $exportPath = Join-Path ([System.IO.Path]::GetTempPath()) "$DistroName-$([guid]::NewGuid().ToString("N")).tar"
  }
  if (Test-Path $outputPath) {
    Remove-Item -Force $outputPath
  }
  Invoke-WslHost -WslArgs @("--export", $DistroName, $exportPath) | Out-Null
  if ($gzipOutput) {
    Compress-Gzip $exportPath $outputPath
    Remove-Item -Force $exportPath
  }
  $hash = (Get-FileHash -Algorithm SHA256 -Path $outputPath).Hash.ToLowerInvariant()
  [pscustomobject]@{
    output = $outputPath
    sha256 = $hash
  } | ConvertTo-Json -Compress
}

function Compress-Gzip {
  param([string]$InputPath, [string]$OutputPath)
  $inputStream = [System.IO.File]::OpenRead($InputPath)
  try {
    $outputStream = [System.IO.File]::Create($OutputPath)
    try {
      $gzipStream = [System.IO.Compression.GzipStream]::new($outputStream, [System.IO.Compression.CompressionLevel]::Optimal)
      try {
        $inputStream.CopyTo($gzipStream)
      } finally {
        $gzipStream.Dispose()
      }
    } finally {
      $outputStream.Dispose()
    }
  } finally {
    $inputStream.Dispose()
  }
}

Assert-Inputs
$installRoot = $null
try {
  $installRoot = Initialize-Distro
  Invoke-Provisioner
  Optimize-Distro
  Invoke-WslHost -WslArgs @("--terminate", $DistroName) | Out-Null
  Export-Distro
} finally {
  if (-not $KeepDistro) {
    if (Test-DistroPresent) {
      Invoke-WslHost -WslArgs @("--unregister", $DistroName) | Out-Null
    }
    if ($installRoot -and (Test-Path $installRoot)) {
      Remove-Item -Recurse -Force $installRoot
    }
  }
}
