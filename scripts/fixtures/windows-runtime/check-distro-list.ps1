param([string]$FixtureRoot)
$ErrorActionPreference = "Stop"

function Assert-ListingFailure([scriptblock]$Action, [string]$Expected) {
  $threw = $false
  try { & $Action } catch {
    $threw = $true
    Assert-Equal $_.Exception.Message $Expected "listing failure preserves its diagnostic"
  }
  Assert-Equal $threw $true "listing failure must propagate"
}

# Use the real process transport and status/install functions; only the rootfs
# download is stubbed. The native fixture logs every call and simulates import.
function Get-RootfsPath { Join-Path $FixtureRoot "rootfs.tar" }
$savedLocalAppData = $env:LOCALAPPDATA
try {
  $env:LOCALAPPDATA = $FixtureRoot
  $responses = Get-Content -LiteralPath (Join-Path $PSScriptRoot "list-responses.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($response in $responses) {
    $env:BLAME_TEST_WSL_LIST_CODE = [string]$response.code
    $env:BLAME_TEST_WSL_LIST_STDOUT = $response.stdout
    $env:BLAME_TEST_WSL_LIST_STDERR = $response.stderr
    if ($response.absent) {
      Assert-Equal (Test-DistroPresent) $false "$($response.name): distro absent"
      $status = Get-RuntimeStatus | ConvertFrom-Json
      Assert-Equal $status.status "missing" "$($response.name): status permits installation"
      Assert-Equal $status.checks[1].name "distro" "$($response.name): missing distro check"
      Assert-Equal $status.checks[1].status "missing" "$($response.name): missing distro check status"
      Clear-Content -LiteralPath $env:BLAME_TEST_WSL_LOG
      Assert-Equal (Ensure-Distro) $true "$($response.name): import succeeds"
      $calls = @(Get-Content -LiteralPath $env:BLAME_TEST_WSL_LOG -Encoding UTF8 | ForEach-Object { ,(ConvertFrom-Json $_) })
      Assert-Equal $calls.Count 3 "$($response.name): status, list, import"
      Assert-Equal $calls[2] @('--import', $DistroName, (Join-Path $FixtureRoot "Blame\runtime\wsl\$DistroName"), (Get-RootfsPath), '--version', '2') "$($response.name): import argv"
    } else {
      $expected = ((@($response.stdout, $response.stderr) | Where-Object { $_ }) -join "`n").TrimEnd()
      Assert-ListingFailure { Test-DistroPresent } $expected
      Assert-ListingFailure { Get-RuntimeStatus } $expected
      Clear-Content -LiteralPath $env:BLAME_TEST_WSL_LOG
      & {
        function Get-RootfsPath { throw "Unexpected rootfs download after listing failure" }
        Assert-ListingFailure { Ensure-Distro } $expected
      }
      $calls = @(Get-Content -LiteralPath $env:BLAME_TEST_WSL_LOG -Encoding UTF8 | ForEach-Object { ,(ConvertFrom-Json $_) })
      Assert-Equal $calls.Count 2 "$($response.name): stop before import"
      Assert-Equal $calls[0] @('--status') "$($response.name): availability check"
      Assert-Equal $calls[1] @('--list', '--verbose') "$($response.name): listing check"
    }
    Write-Output "WSL listing check passed: $($response.name)"
  }
} finally {
  $env:LOCALAPPDATA = $savedLocalAppData
  $env:BLAME_TEST_WSL_LIST_CODE = $null
  $env:BLAME_TEST_WSL_LIST_STDOUT = $null
  $env:BLAME_TEST_WSL_LIST_STDERR = $null
}
