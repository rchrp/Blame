# Fails unless the file carries a valid Authenticode signature from the
# publisher that signed Blame's Windows releases: the in-app updater refuses
# updates from any other publisher (see electron-builder.config.ts).
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Publisher = "SignPath Foundation"
)

$signature = Get-AuthenticodeSignature -LiteralPath $Path
$subject = $signature.SignerCertificate.Subject
if ($signature.Status -ne "Valid") {
  Write-Error "$Path is not validly signed: $($signature.Status) $($signature.StatusMessage)"
  exit 1
}
if ($subject -notmatch "(^|,\s*)CN=`"?$([regex]::Escape($Publisher))`"?(,|$)") {
  Write-Error "$Path is signed by '$subject', not $Publisher"
  exit 1
}
Write-Host "$Path is signed by $subject"
