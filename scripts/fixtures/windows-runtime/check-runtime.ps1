param([string]$RuntimeScript, [string]$FixtureRoot, [string]$NativeFixture)
$ErrorActionPreference = "Stop"

function Assert-Equal($Actual, $Expected, [string]$Message) {
  # PS 5.1 adds ETS properties to some pipeline arrays; ConvertTo-Json then
  # wraps them as { value, Count }. Compare array elements instead of metadata.
  if ($Expected -is [array]) {
    $actualItems = @($Actual)
    if ($actualItems.Count -ne $Expected.Count) {
      throw "${Message}: expected $($Expected.Count) items; got $($actualItems.Count)"
    }
    for ($index = 0; $index -lt $Expected.Count; $index++) {
      Assert-Equal $actualItems[$index] $Expected[$index] "$Message at index $index"
    }
    return
  }
  if ($Actual -is [array] -or $Actual -cne $Expected) {
    throw "${Message}: expected <$Expected>; got <$Actual>"
  }
}
function Assert-Throws([scriptblock]$Action, [string]$Message) {
  $threw = $false
  try { & $Action } catch { $threw = $true }
  if (-not $threw) { throw $Message }
}

if ($env:OS -eq "Windows_NT") {
  # CI uses Windows PowerShell 5.1, the same engine as the packaged desktop.
  Add-Type -Path $NativeFixture -OutputAssembly (Join-Path $FixtureRoot "wsl.exe") -OutputType ConsoleApplication
}
# Windows runners also have a real wsl.exe. Reproduce duplicate PATH matches
# on every host, since Get-Command -CommandType Application returns them all.
$secondFixtureRoot = Join-Path $FixtureRoot "second-wsl"
[System.IO.Directory]::CreateDirectory($secondFixtureRoot) | Out-Null
Copy-Item -LiteralPath (Join-Path $FixtureRoot "wsl.exe") -Destination (Join-Path $secondFixtureRoot "wsl.exe")
$env:PATH = $FixtureRoot + [System.IO.Path]::PathSeparator + $secondFixtureRoot + [System.IO.Path]::PathSeparator + $env:PATH
$env:BLAME_TEST_WSL_LOG = Join-Path $FixtureRoot "calls.jsonl"
$env:BLAME_TEST_WSL_INPUT = Join-Path $FixtureRoot "stdin.txt"
$env:BLAME_TEST_WSL_PATH = "/mnt/c/Users/Ren$([char]0xe9) O'Neil [test]/" + '$cash & tools/payload.tgz'
$env:BLAME_WSL_DISTRO = "BlameRuntime"
. $RuntimeScript --version | Out-Null

# Actual argv round trip through ProcessStartInfo.Arguments, including values
# that PowerShell 5.1's native invocation and the old quoting helper lost.
$arguments = @("--echo", 'C:\Users\vanwa\payload.tgz', 'C:\Program Files\Blame\',
  '', 'a"b', 'a\"b', 'two\\"quotes', "line`nend", "tab`tend", '$HOME $(whoami) & | ;',
  "R$([char]0xe9)pertoire [test]", "O'Neil", 'sh', '-lc', 'printf "%s" "$HOME"')
$result = Invoke-WslHost -WslArgs $arguments
Assert-Equal $result.Code 0 "argv process status"
Assert-Equal ($result.Stdout | ConvertFrom-Json) $arguments "native argv preservation"

$result = Invoke-WslHost -WslArgs @("--warning")
Assert-Equal $result.Code 0 "stderr warning must not fail"
Assert-Equal $result.Stdout "ok" "stdout isolation"
Assert-Equal $result.Stderr "warning" "stderr isolation"
$result = Invoke-WslHost -WslArgs @("--fail")
Assert-Equal $result.Code 23 "native failure code"
Assert-Equal $result.Output "partial`nfailed" "failure diagnostics"
$result = Invoke-WslHost -WslArgs @("--fail") -InputContent ("x" * 1048576)
Assert-Equal $result.Code 23 "launch failure before stdin is consumed"
Assert-Equal $result.Output "partial`nfailed" "broken pipe preserves WSL diagnostic"

$inputText = "# caf$([char]0xe9)`r`n" + ("x" * 262144)
$result = Invoke-WslHost -WslArgs @("--flood") -InputContent $inputText
Assert-Equal $result.Code 0 "concurrent stream draining"
Assert-Equal $result.Stdout (("o" * 262144) + $inputText.Replace("`r`n", "`n")) "UTF-8 stdin without BOM"
Assert-Equal $result.Stderr.Length 262144 "full stderr drained"
$result = Invoke-DistroScript "echo caf$([char]0xe9)`r`necho done`r"
Assert-Equal $result.Stdout "echo caf$([char]0xe9)`necho done`n" "script line endings"
Assert-Equal (Test-WslAvailable) $true "WSL status tolerates warnings"
Assert-Equal (Test-DistroPresent) $true "distro list ignores stderr"
$env:BLAME_TEST_WSL_FAIL = "no-distros"
Assert-Equal (Test-DistroPresent) $false "distro list handles absence of installed distributions"
$env:BLAME_TEST_WSL_FAIL = "list"
Assert-Throws { Test-DistroPresent } "Failed listing must not be treated as an absent distro"
$env:BLAME_TEST_WSL_FAIL = ""
& {
  function Get-Command { return $null }
  Assert-Equal (Test-WslAvailable) $false "missing wsl.exe is unsupported"
}
& {
  function Invoke-DistroScript { [pscustomobject]@{ Code = 0; Stdout = ""; Stderr = "warning" } }
  $checks = New-Object System.Collections.Generic.List[object]
  Add-DistroChecks $checks
  Assert-Equal $checks.Count 9 "empty probe output retains required checks"
  Assert-Equal @($checks | Where-Object { $_.status -ne 'missing' }).Count 0 "empty probe output is not ready"
}
& {
  function Invoke-DistroScript { [pscustomobject]@{ Code = 0; Stdout = "agent`tavailable`r`ngit`tavailable`n" } }
  $checks = New-Object System.Collections.Generic.List[object]
  Add-DistroChecks $checks
  Assert-Equal @($checks | Where-Object { $_.status -eq 'available' }).Count 2 "partial probe output keeps valid results"
  Assert-Equal @($checks | Where-Object { $_.status -eq 'missing' }).Count 7 "partial probe output does not hide missing results"
}

Clear-Content -LiteralPath $env:BLAME_TEST_WSL_LOG
Invoke-Provisioner
$calls = @(Get-Content -LiteralPath $env:BLAME_TEST_WSL_LOG -Encoding UTF8 | ForEach-Object { ,(ConvertFrom-Json $_) })
Assert-Equal $calls.Count 3 "translate, copy, provision"
Assert-Equal $calls[0] @('-d', 'BlameRuntime', '-u', 'root', '--exec', 'wslpath', '-u', $SemanticHarnessPayload) "literal payload path"
Assert-Equal $calls[1] @('-d', 'BlameRuntime', '-u', 'root', '--exec', 'cp', '--', $env:BLAME_TEST_WSL_PATH, '/tmp/blame-semantic-harness.tgz') "translated path excludes stderr"
Assert-Equal $calls[2] @('-d', 'BlameRuntime', '-u', 'root', '--exec', 'sh', '-s', '--', $RuntimeVersion, $ClineSdkVersion) "provisioner argv"
Assert-Equal (Get-Content -LiteralPath $env:BLAME_TEST_WSL_INPUT -Raw -Encoding UTF8) "echo provision`n" "provisioner stdin"
foreach ($failure in @('wslpath', 'cp', 'provision')) {
  Clear-Content -LiteralPath $env:BLAME_TEST_WSL_LOG
  $env:BLAME_TEST_WSL_FAIL = $failure
  Assert-Throws { Invoke-Provisioner } "Provisioning must propagate $failure failure"
  $expectedCalls = @{ wslpath = 1; cp = 2; provision = 3 }
  Assert-Equal @(Get-Content -LiteralPath $env:BLAME_TEST_WSL_LOG).Count $expectedCalls[$failure] "stop after $failure failure"
}
$env:BLAME_TEST_WSL_FAIL = ""

# Rootfs cache paths share the user's profile directory, which can contain
# wildcard characters. Exercise download, reuse and corrupt-cache replacement.
& {
  $script:downloads = 0
  function Get-CacheRoot { Join-Path $FixtureRoot "cache [test]" }
  function Invoke-RootfsDownload([string]$Uri, [string]$Path) {
    $script:downloads++
    [System.IO.File]::WriteAllText($Path, "rootfs", [System.Text.UTF8Encoding]::new($false))
  }
  $digest = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = -join ($digest.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("rootfs")) | ForEach-Object { $_.ToString("x2") })
  } finally { $digest.Dispose() }
  $spec = [pscustomobject]@{ url = "https://unused.invalid/runtime.tar.gz"; sha256 = $hash }
  $cached = Get-CachedRootfsPath $spec
  Assert-Equal (Get-CachedRootfsPath $spec) $cached "reuse verified cache"
  Assert-Equal $script:downloads 1 "cached rootfs must not download again"
  [System.IO.File]::WriteAllText($cached, "corrupt")
  Assert-Equal (Get-CachedRootfsPath $spec) $cached "replace corrupt cached rootfs"
  Assert-Equal $script:downloads 2 "corrupt cache must download again"
}

# A current stopped distro must not reinstall its payload; explicit repair must.
& {
  function Ensure-Distro { return $false }
  function Test-ImportedRuntimeReady { return $true }
  function Ensure-DockerRunning { }
  function Get-RuntimeStatus { }
  function Invoke-Provisioner { throw "Unexpected provisioning of healthy distro" }
  Ensure-Runtime
}
& {
  $script:provisions = 0
  function Ensure-Distro { return $false }
  function Test-ImportedRuntimeReady { return $false }
  function Get-RuntimeStatus { }
  function Invoke-Provisioner { $script:provisions++ }
  Ensure-Runtime
  Repair-Runtime
  Assert-Equal $script:provisions 2 "stale distro and explicit repair provision"
}
& {
  $script:resetContinued = $false
  function Test-DistroPresent { return $true }
  function Ensure-Runtime { $script:resetContinued = $true }
  Assert-Throws { Reset-Runtime } "Reset failure"
  Assert-Equal $script:resetContinued $false "Reset must stop after unregister failed"
  Assert-Throws { Uninstall-Runtime } "Uninstall failure"
}
Write-Output "Windows runtime process checks passed"
