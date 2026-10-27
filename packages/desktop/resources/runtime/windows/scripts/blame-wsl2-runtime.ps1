$ErrorActionPreference = "Stop"

# PowerShell 7 -> Node/Electron -> powershell.exe inherits PS7's PSModulePath.
# Pin utilities to this engine so autoloading cannot select an incompatible
# Microsoft.PowerShell.Utility (notably losing Get-FileHash under PS 5.1).
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1" -Force

$DistroName = if ($env:BLAME_WSL_DISTRO) { $env:BLAME_WSL_DISTRO } else { "BlameRuntime" }
$RuntimeHome = Split-Path -Parent $PSScriptRoot
$ManifestPath = Join-Path $RuntimeHome "manifest.json"
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$RuntimeVersion = [string]$Manifest.runtimeVersion
$RuntimeAgentVersion = if ($Manifest.PSObject.Properties["runtimeAgentVersion"]) {
  [string]$Manifest.runtimeAgentVersion
} else {
  "1"
}
$ClineSdkVersion = if ($env:BLAME_CLINE_SDK_VERSION) {
  [string]$env:BLAME_CLINE_SDK_VERSION
} elseif ($Manifest.PSObject.Properties["clineSdkVersion"]) {
  [string]$Manifest.clineSdkVersion
} else {
  "0.2.0"
}
$SemanticHarnessPayload = Join-Path $RuntimeHome "payloads\blame-semantic-harness.tgz"
$SemanticHarnessSha256 = if (Test-Path -LiteralPath $SemanticHarnessPayload) {
  (Get-FileHash -Algorithm SHA256 -LiteralPath $SemanticHarnessPayload).Hash.ToLowerInvariant()
} else {
  ""
}
$WslRequiredAction = "Enable WSL2 in Windows, restart if prompted, then run Blame runtime setup again."
$RootfsAction = "Blame could not download the BlameRuntime WSL2 rootfs. Check the internet connection, then run Blame runtime setup again."

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http

function Invoke-WslHost {
  param([string[]]$WslArgs, [string]$InputContent, [switch]$InheritOutput)
  # Windows PowerShell turns redirected native stderr into terminating errors
  # under ErrorActionPreference=Stop, including successful WSL warnings.
  # Process also avoids PowerShell 5.1's lossy native argument serialization.
  $process = [System.Diagnostics.Process]::new()
  # Filtering by Application can return multiple PATH matches. Select one
  # before assigning FileName, otherwise PowerShell joins the paths with spaces.
  $wslCommand = Get-Command wsl.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $process.StartInfo.FileName = $wslCommand.Path
  $process.StartInfo.Arguments = Join-Arguments $WslArgs
  $process.StartInfo.RedirectStandardInput = $PSBoundParameters.ContainsKey("InputContent")
  $process.StartInfo.RedirectStandardOutput = -not $InheritOutput
  $process.StartInfo.RedirectStandardError = -not $InheritOutput
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.EnvironmentVariables["WSL_UTF8"] = "1"
  if (-not $InheritOutput) {
    $process.StartInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $process.StartInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  }
  try {
    $process.Start() | Out-Null
    if (-not $InheritOutput) {
      # Drain both streams concurrently, before writing potentially large scripts.
      $standardOutputTask = $process.StandardOutput.ReadToEndAsync()
      $standardErrorTask = $process.StandardError.ReadToEndAsync()
    }
    $inputFailure = $null
    if ($process.StartInfo.RedirectStandardInput) {
      try {
        # Explicit UTF-8 without a BOM, independent of the Windows code page.
        $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-UnixLineEndings $InputContent))
        $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
      } catch {
        # WSL can reject the launch before reading stdin. Keep its diagnostic
        # and exit code instead of replacing them with a broken-pipe exception.
        $inputFailure = $_
      } finally {
        try { $process.StandardInput.Close() } catch {
          if (-not $inputFailure) { $inputFailure = $_ }
        }
      }
    }
    $process.WaitForExit()
    $stdout = ""
    $stderr = ""
    if (-not $InheritOutput) {
      $stdout = $standardOutputTask.GetAwaiter().GetResult()
      $stderr = $standardErrorTask.GetAwaiter().GetResult()
    }
    if ($inputFailure -and $process.ExitCode -eq 0) { throw $inputFailure }
    [pscustomobject]@{
      Code = $process.ExitCode
      Stdout = $stdout
      Stderr = $stderr
      Output = ((@($stdout, $stderr) | Where-Object { $_ }) -join "`n").TrimEnd()
    }
  } finally {
    $process.Dispose()
  }
}

function Invoke-DistroScript {
  param([string]$Content)
  Invoke-WslHost -WslArgs @("-d", $DistroName, "-u", "root", "--exec", "sh", "-s") -InputContent $Content
}

function ConvertTo-UnixLineEndings {
  param([string]$Content)
  $Content -replace "`r`n?", "`n"
}

function Write-Status {
  param([string]$Status, [object[]]$Checks, [string]$Action = "")
  $report = [ordered]@{
    status = $Status
    checks = $Checks
  }
  if ($Action) {
    $report.action = $Action
  }
  $report | ConvertTo-Json -Depth 4 -Compress
}

function Write-RuntimeProgress {
  param([string]$Phase, [long]$CompletedBytes = 0, [long]$TotalBytes = 0)
  $progress = [ordered]@{
    phase = $Phase
  }
  if ($TotalBytes -gt 0) {
    $progress.completedBytes = $CompletedBytes
    $progress.totalBytes = $TotalBytes
    $progress.percent = [math]::Min(100, [math]::Floor(($CompletedBytes * 100) / $TotalBytes))
  }
  Write-Host "BLAME_RUNTIME_PROGRESS $($progress | ConvertTo-Json -Compress)"
}

function New-Check {
  param([string]$Name, [string]$Status, [string]$Action = "")
  $check = [ordered]@{
    name = $Name
    status = $Status
  }
  if ($Action) {
    $check.action = $Action
  }
  [pscustomobject]$check
}

function Get-OptionalProperty {
  param([object]$Value, [string]$Name)
  if ($null -eq $Value) {
    return $null
  }
  $property = $Value.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  $property.Value
}

function Get-WslListText {
  $result = Invoke-WslHost -WslArgs @("--list", "--verbose")
  if ($result.Code -ne 0) {
    throw $result.Output
  }
  ($result.Stdout -replace "`0", "")
}

function Test-WslAvailable {
  if (-not (Get-Command wsl.exe -CommandType Application -ErrorAction SilentlyContinue)) {
    return $false
  }
  $result = Invoke-WslHost -WslArgs @("--status")
  $result.Code -eq 0
}

function Test-DistroPresentText {
  param([string]$Text)
  $Text -match "(?m)^\s*\*?\s*$([regex]::Escape($DistroName))\s"
}

function Test-DistroPresent {
  Test-DistroPresentText (Get-WslListText)
}

function Test-DistroUsesWsl2Text {
  param([string]$Text)
  $Text -match "(?m)^\s*\*?\s*$([regex]::Escape($DistroName))\s+\S+\s+2\s*$"
}

function Test-DistroUsesWsl2 {
  Test-DistroUsesWsl2Text (Get-WslListText)
}

function Test-ContainerRuntimeCommand {
  param([string[]]$CommandArgs)
  if ($CommandArgs[0] -match "^(compose|container|info|inspect|network|volume)$") {
    return $true
  }
  $CommandArgs[0] -eq "sh" -and (($CommandArgs -join " ") -match "\bdocker\b")
}

function Ensure-DockerRunning {
  $command = "blame-runtime-agent docker-ensure"
  $result = Invoke-DistroScript $command
  if ($result.Code -ne 0) {
    throw $result.Output
  }
}

function Get-StatusChecks {
  $checks = New-Object System.Collections.Generic.List[object]
  if (-not (Test-WslAvailable)) {
    $checks.Add((New-Check "wsl" "unsupported" $WslRequiredAction))
    return $checks
  }
  $checks.Add((New-Check "wsl" "available"))
  $wslListText = Get-WslListText
  if (-not (Test-DistroPresentText $wslListText)) {
    $checks.Add((New-Check "distro" "missing" "Create the BlameRuntime WSL2 distro from Blame runtime setup."))
    return $checks
  }
  $checks.Add((New-Check "distro" "available"))
  if (-not (Test-DistroUsesWsl2Text $wslListText)) {
    $checks.Add((New-Check "wsl2" "unsupported" "Convert BlameRuntime to WSL2 with wsl --set-version BlameRuntime 2, then retry."))
    return $checks
  }
  $checks.Add((New-Check "wsl2" "available"))
  Add-DistroChecks $checks
  $checks
}

function Add-DistroChecks {
  param([System.Collections.Generic.List[object]]$Checks)
  $command = @'
check() {
  name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf '%s\tavailable\n' "$name"
  else
    printf '%s\tmissing\n' "$name"
  fi
}
node_major_ok() {
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
}
valid_cline_sdk_install() {
  node_major_ok || return 1
  command -v npm >/dev/null 2>&1 || return 1
  global_node_root="$(npm root -g)"
  node - "$global_node_root" "__CLINE_SDK_VERSION__" <<'NODE'
const fs = require("fs");
const path = require("path");
const root = path.join(process.argv[2], "@blame/semantic-harness-runtime/node_modules");
const version = process.argv[3];
const sdkPackage = path.join(root, "@cline/sdk/package.json");
const coreRoot = path.join(root, "../vendor/cline-core");
if (!fs.existsSync(sdkPackage) || !coreRoot) process.exit(1);
const sdk = JSON.parse(fs.readFileSync(sdkPackage, "utf8"));
const core = JSON.parse(fs.readFileSync(path.join(coreRoot, "package.json"), "utf8"));
const sdkEntry = path.join(root, "@cline/sdk/dist/index.js");
process.exit(sdk.version === version && core.version === version && fs.existsSync(sdkEntry) && fs.existsSync(path.join(coreRoot, "dist/blame-patch.json")) ? 0 : 1);
NODE
}
check agent test -x /usr/local/bin/blame-runtime-agent
check agent-version sh -lc 'test "$(blame-runtime-agent agent-version 2>/dev/null)" = "__RUNTIME_AGENT_VERSION__"'
check runtime-version sh -lc 'test "$(cat /etc/blame-runtime-version 2>/dev/null)" = "__RUNTIME_VERSION__"'
check docker sh -lc 'command -v dockerd >/dev/null 2>&1 && command -v docker >/dev/null 2>&1'
check docker-compose sh -lc 'docker compose version >/dev/null 2>&1'
check git sh -lc 'command -v git >/dev/null 2>&1'
check cline-sdk valid_cline_sdk_install
check semantic-harness sh -lc 'command -v blame-semantic-harness >/dev/null 2>&1 && test "$(cat /etc/blame-semantic-harness-sha256 2>/dev/null)" = "__SEMANTIC_HARNESS_SHA256__"'
check package-managers sh -lc 'test "$(/opt/blame/package-managers/pnpm/12.15.0/bin/pnpm --version 2>/dev/null)" = "12.15.0" && test "$(/opt/blame/package-managers/pnpm/10.33.2/bin/pnpm --version 2>/dev/null)" = "10.33.2" && test "$(/opt/blame/package-managers/npm/12.2.1/bin/npm --version 2>/dev/null)" = "12.2.1" && test "$(/opt/blame/package-managers/npm/11.6.4/bin/npm --version 2>/dev/null)" = "11.6.4" && test "$(/opt/blame/package-managers/yarn/1.22.22/bin/yarn --version 2>/dev/null)" = "1.22.22"'
'@
  $command = $command -replace "__CLINE_SDK_VERSION__", $ClineSdkVersion
  $command = $command -replace "__RUNTIME_AGENT_VERSION__", $RuntimeAgentVersion
  $command = $command -replace "__RUNTIME_VERSION__", $RuntimeVersion
  $command = $command -replace "__SEMANTIC_HARNESS_SHA256__", $SemanticHarnessSha256
  $result = Invoke-DistroScript $command
  $reported = @{}
  if ($result.Code -eq 0) {
    foreach ($line in ($result.Stdout -split "`n")) {
      $parts = $line.TrimEnd("`r") -split "`t", 2
      if ($parts.Count -eq 2) { $reported[$parts[0]] = $parts[1] }
    }
  }
  # Missing/truncated probe output must never turn a broken distro into ready.
  foreach ($name in @("agent", "agent-version", "runtime-version", "docker", "docker-compose", "git", "cline-sdk", "semantic-harness", "package-managers")) {
    if ($reported[$name] -eq "available") {
      $Checks.Add((New-Check $name "available"))
    } else {
      $Checks.Add((New-Check $name "missing" "Repair BlameRuntime from Blame runtime setup."))
    }
  }
}

function Get-RuntimeStatus {
  $checks = Get-StatusChecks
  $failed = $checks | Where-Object { $_.status -ne "available" } | Select-Object -First 1
  if ($null -eq $failed) {
    Write-Status "ready" $checks
    return
  }
  if ($failed.name -eq "wsl" -or $failed.name -eq "wsl2") {
    Write-Status "unsupported" $checks $failed.action
    return
  }
  if ($failed.name -eq "distro" -or $failed.name -eq "agent") {
    Write-Status "missing" $checks $failed.action
    return
  }
  Write-Status "repairable" $checks $failed.action
}

function Assert-WslReady {
  if (Test-WslAvailable) {
    return
  }
  throw $WslRequiredAction
}

function Get-RootfsPath {
  $spec = Get-RootfsSpec
  if ($env:BLAME_WSL2_ROOTFS -and (Test-Path -LiteralPath $env:BLAME_WSL2_ROOTFS)) {
    Confirm-RootfsChecksum $env:BLAME_WSL2_ROOTFS $spec
    return $env:BLAME_WSL2_ROOTFS
  }
  $packagedRootfs = Join-Path $RuntimeHome "rootfs\BlameRuntime-rootfs.tar"
  if (Test-Path -LiteralPath $packagedRootfs) {
    Confirm-RootfsChecksum $packagedRootfs $spec
    return $packagedRootfs
  }
  $packagedCompressedRootfs = Join-Path $RuntimeHome "rootfs\BlameRuntime-rootfs.tar.gz"
  if (Test-Path -LiteralPath $packagedCompressedRootfs) {
    Confirm-RootfsChecksum $packagedCompressedRootfs $spec
    return $packagedCompressedRootfs
  }
  Get-CachedRootfsPath $spec
}

function Get-CachedRootfsPath {
  param([object]$Spec)
  $cacheRoot = Get-CacheRoot
  $fileName = Split-Path $Spec.url -Leaf
  $rootfs = Join-Path $cacheRoot $fileName
  if (Test-Path -LiteralPath $rootfs) {
    try {
      Confirm-RootfsChecksum $rootfs $Spec
      return $rootfs
    } catch {
      Remove-Item -Force -LiteralPath $rootfs
    }
  }
  New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
  $download = "$rootfs.download"
  if (Test-Path -LiteralPath $download) {
    Remove-Item -Force -LiteralPath $download
  }
  try {
    Invoke-RootfsDownload $Spec.url $download
    Confirm-RootfsChecksum $download $Spec
    Move-Item -Force -LiteralPath $download -Destination $rootfs
    return $rootfs
  } catch {
    if (Test-Path -LiteralPath $download) {
      Remove-Item -Force -LiteralPath $download
    }
    throw $RootfsAction
  }
}

function Invoke-RootfsDownload {
  param([string]$Uri, [string]$Path)
  $client = [System.Net.Http.HttpClient]::new()
  $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
  $response = $null
  $inputStream = $null
  try {
    $response = $client.GetAsync($Uri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode() | Out-Null
    $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    Copy-DownloadStream $inputStream $Path $response.Content.Headers.ContentLength
  } finally {
    if ($inputStream) {
      $inputStream.Dispose()
    }
    if ($response) {
      $response.Dispose()
    }
    $client.Dispose()
  }
}

function Copy-DownloadStream {
  param([System.IO.Stream]$InputStream, [string]$Path, [long]$TotalBytes)
  $outputStream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  $buffer = New-Object byte[] (1024 * 1024)
  $completedBytes = 0L
  $lastPercent = -1
  try {
    while (($read = $InputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $outputStream.Write($buffer, 0, $read)
      $completedBytes += $read
      $percent = if ($TotalBytes -gt 0) { [math]::Floor(($completedBytes * 100) / $TotalBytes) } else { 0 }
      if ($percent -ne $lastPercent) {
        Write-RuntimeProgress "downloading" $completedBytes $TotalBytes
        $lastPercent = $percent
      }
    }
  } finally {
    $outputStream.Dispose()
  }
}

function Assert-RootfsChecksum {
  param([string]$Path, [object]$Spec)
  $sha256 = Get-OptionalProperty $Spec "sha256"
  if (-not $sha256) {
    return
  }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($actual -ne ([string]$sha256).ToLowerInvariant()) {
    throw "BlameRuntime rootfs checksum mismatch."
  }
}

function Confirm-RootfsChecksum {
  param([string]$Path, [object]$Spec)
  Write-RuntimeProgress "verifying"
  Assert-RootfsChecksum $Path $Spec
}

function Get-RootfsSpec {
  $architecture = Get-RuntimeArchitecture
  $spec = $Manifest.rootfs.$architecture
  if ($null -eq $spec -or -not $spec.url) {
    throw "BlameRuntime does not provide a WSL2 rootfs for $architecture."
  }
  $spec
}

function Get-RuntimeArchitecture {
  $architecture = $env:PROCESSOR_ARCHITECTURE
  if ($architecture -eq "ARM64") {
    return "arm64"
  }
  "amd64"
}

function Get-CacheRoot {
  $localAppData = $env:LOCALAPPDATA
  if (-not $localAppData) {
    $localAppData = [System.IO.Path]::GetTempPath()
  }
  Join-Path $localAppData "Blame\runtime\cache"
}

function Ensure-Distro {
  Assert-WslReady
  if (Test-DistroPresent) {
    return $false
  }
  $rootfs = Get-RootfsPath
  if (-not $rootfs) {
    throw $RootfsAction
  }
  $installRoot = Join-Path $env:LOCALAPPDATA "Blame\runtime\wsl\$DistroName"
  New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
  Write-RuntimeProgress "installing"
  $result = Invoke-WslHost -WslArgs @("--import", $DistroName, $installRoot, $rootfs, "--version", "2")
  if ($result.Code -ne 0) {
    throw $result.Output
  }
  $true
}

function Invoke-Provisioner {
  Write-RuntimeProgress "configuring"
  $script = Join-Path $PSScriptRoot "provision-blame-runtime.sh"
  if (-not (Test-Path -LiteralPath $SemanticHarnessPayload)) {
    throw "Blame semantic harness runtime payload is missing."
  }
  $resolvedPayload = (Resolve-Path -LiteralPath $SemanticHarnessPayload).Path
  $translated = Invoke-WslHost -WslArgs @("-d", $DistroName, "-u", "root", "--exec", "wslpath", "-u", $resolvedPayload)
  if ($translated.Code -ne 0) {
    throw $translated.Output
  }
  $wslPayload = $translated.Stdout.TrimEnd("`r", "`n")
  if (-not $wslPayload) {
    throw "Could not translate the Blame semantic harness payload path for WSL2."
  }
  $copy = Invoke-WslHost -WslArgs @("-d", $DistroName, "-u", "root", "--exec", "cp", "--", $wslPayload, "/tmp/blame-semantic-harness.tgz")
  if ($copy.Code -ne 0) {
    throw $copy.Output
  }
  $content = Get-Content -LiteralPath $script -Raw -Encoding UTF8
  $result = Invoke-WslHost -WslArgs @("-d", $DistroName, "-u", "root", "--exec", "sh", "-s", "--", $RuntimeVersion, $ClineSdkVersion) -InputContent $content -InheritOutput
  if ($result.Code -ne 0) {
    throw "BlameRuntime provisioning failed."
  }
}

function Test-ImportedRuntimeReady {
  $command = @'
version_ok() {
  test "$(cat /etc/blame-runtime-version 2>/dev/null)" = "__RUNTIME_VERSION__"
}
agent_version_ok() {
  test "$(blame-runtime-agent agent-version 2>/dev/null)" = "__RUNTIME_AGENT_VERSION__"
}
node_major_ok() {
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
}
valid_cline_sdk_install() {
  node_major_ok || return 1
  command -v npm >/dev/null 2>&1 || return 1
  global_node_root="$(npm root -g)"
  node - "$global_node_root" "__CLINE_SDK_VERSION__" <<'NODE'
const fs = require("fs");
const path = require("path");
const root = path.join(process.argv[2], "@blame/semantic-harness-runtime/node_modules");
const version = process.argv[3];
const sdkPackage = path.join(root, "@cline/sdk/package.json");
const coreRoot = path.join(root, "../vendor/cline-core");
const sdkEntry = path.join(root, "@cline/sdk/dist/index.js");
if (!fs.existsSync(sdkPackage) || !coreRoot) process.exit(1);
const sdk = JSON.parse(fs.readFileSync(sdkPackage, "utf8"));
const core = JSON.parse(fs.readFileSync(path.join(coreRoot, "package.json"), "utf8"));
process.exit(sdk.version === version && core.version === version && fs.existsSync(sdkEntry) && fs.existsSync(path.join(coreRoot, "dist/blame-patch.json")) ? 0 : 1);
NODE
}
version_ok &&
  agent_version_ok &&
  id blame >/dev/null 2>&1 &&
  command -v node >/dev/null 2>&1 &&
  node_major_ok &&
  command -v docker >/dev/null 2>&1 &&
  command -v dockerd >/dev/null 2>&1 &&
  docker compose version >/dev/null 2>&1 &&
  test -x /usr/local/bin/blame-runtime-agent &&
  valid_cline_sdk_install &&
  command -v blame-semantic-harness >/dev/null 2>&1 &&
  test "$(cat /etc/blame-semantic-harness-sha256 2>/dev/null)" = "__SEMANTIC_HARNESS_SHA256__" &&
  test "$(/opt/blame/package-managers/pnpm/12.15.0/bin/pnpm --version 2>/dev/null)" = "12.15.0" && test "$(/opt/blame/package-managers/pnpm/10.33.2/bin/pnpm --version 2>/dev/null)" = "10.33.2" &&
  test "$(/opt/blame/package-managers/npm/12.2.1/bin/npm --version 2>/dev/null)" = "12.2.1" && test "$(/opt/blame/package-managers/npm/11.6.4/bin/npm --version 2>/dev/null)" = "11.6.4" &&
  test "$(/opt/blame/package-managers/yarn/1.22.22/bin/yarn --version 2>/dev/null)" = "1.22.22"
'@
  $command = $command -replace "__CLINE_SDK_VERSION__", $ClineSdkVersion
  $command = $command -replace "__RUNTIME_AGENT_VERSION__", $RuntimeAgentVersion
  $command = $command -replace "__RUNTIME_VERSION__", $RuntimeVersion
  $command = $command -replace "__SEMANTIC_HARNESS_SHA256__", $SemanticHarnessSha256
  $result = Invoke-DistroScript $command
  $result.Code -eq 0
}

function Join-Arguments {
  param([string[]]$Items)
  ($Items | ForEach-Object { Quote-Argument $_ }) -join " "
}

function Quote-Argument {
  param([string]$Value)
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }
  # Windows argv parsing doubles backslashes before quotes and before the
  # closing quote; empty strings must also remain individual arguments.
  '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Ensure-Runtime {
  Ensure-Distro | Out-Null
  # An existing, up-to-date distro needs Docker started, not provisioning again.
  # Repair-Runtime remains the explicit way to force provisioning.
  if (Test-ImportedRuntimeReady) {
    $dockerReady = $false
    try {
      Write-RuntimeProgress "starting"
      Ensure-DockerRunning
      $dockerReady = $true
    } catch {
      $dockerReady = $false
    }
    if ($dockerReady) {
      Write-RuntimeProgress "checking"
      Get-RuntimeStatus
      return
    }
  }
  Invoke-Provisioner
  Write-RuntimeProgress "checking"
  Get-RuntimeStatus
}

function Repair-Runtime {
  Ensure-Distro | Out-Null
  Invoke-Provisioner
  Write-RuntimeProgress "checking"
  Get-RuntimeStatus
}

function Reset-Runtime {
  Assert-WslReady
  if (Test-DistroPresent) {
    $result = Invoke-WslHost -WslArgs @("--unregister", $DistroName)
    if ($result.Code -ne 0) { throw $result.Output }
  }
  Ensure-Runtime
}

function Uninstall-Runtime {
  Assert-WslReady
  if (Test-DistroPresent) {
    $result = Invoke-WslHost -WslArgs @("--unregister", $DistroName)
    if ($result.Code -ne 0) { throw $result.Output }
  }
  Get-RuntimeStatus
}

function Invoke-RuntimeCommand {
  param([string[]]$CommandArgs)
  if (-not (Test-DistroPresent)) {
    throw "BlameRuntime is not installed."
  }
  $user = "blame"
  if ($CommandArgs[0] -eq "root") {
    if ($CommandArgs.Count -lt 2) {
      throw "Missing runtime command."
    }
    $CommandArgs = $CommandArgs[1..($CommandArgs.Count - 1)]
    $user = "root"
  }
  if ($CommandArgs[0] -eq "agent") {
    if ($CommandArgs.Count -gt 1) {
      $CommandArgs = @("blame-runtime-agent") + $CommandArgs[1..($CommandArgs.Count - 1)]
    } else {
      $CommandArgs = @("blame-runtime-agent")
    }
    $user = "root"
  }
  $usesContainerRuntime = Test-ContainerRuntimeCommand $CommandArgs
  if ($usesContainerRuntime) {
    $user = "root"
  }
  if ($usesContainerRuntime) {
    Ensure-DockerRunning
  }
  $result = Invoke-WslHost -WslArgs (@("-d", $DistroName, "-u", $user, "--exec") + $CommandArgs) -InheritOutput
  exit $result.Code
}

if ($args.Count -eq 0) {
  Get-RuntimeStatus
  exit 0
}

switch ($args[0]) {
  "--version" {
    "blame-wsl2-runtime $RuntimeVersion"
  }
  "status" {
    Get-RuntimeStatus
  }
  "ensure" {
    Ensure-Runtime
  }
  "repair" {
    Repair-Runtime
  }
  "reset" {
    Reset-Runtime
  }
  "uninstall" {
    Uninstall-Runtime
  }
  "stop" {
    # Ends the distribution's processes when Blame quits.
    Invoke-WslHost -WslArgs @("--terminate", $DistroName) | Out-Null
  }
  default {
    Invoke-RuntimeCommand $args
  }
}
