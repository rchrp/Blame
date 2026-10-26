param([string]$RuntimeScript, [string]$ShadowModuleRoot, [string]$ExpectedHash)
$ErrorActionPreference = "Stop"

# Model a module path inherited through Node/Electron from another PowerShell
# edition. The runtime must load utilities belonging to its own engine.
$env:PSModulePath = $ShadowModuleRoot + [System.IO.Path]::PathSeparator + $env:PSModulePath
Remove-Module Microsoft.PowerShell.Utility -Force -ErrorAction SilentlyContinue
. $RuntimeScript --version | Out-Null
if ($SemanticHarnessSha256 -cne $ExpectedHash) {
  throw "Runtime startup did not hash the payload with the compatible utility module."
}
Assert-RootfsChecksum $SemanticHarnessPayload ([pscustomobject]@{ sha256 = $ExpectedHash })
Write-Output "Runtime module isolation checks passed"
