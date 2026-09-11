# Copies the extension into the CEP extensions folder (unsigned; PlayerDebugMode is already on for this machine).
$src = $PSScriptRoot
$dst = Join-Path $env:APPDATA "Adobe\CEP\extensions\com.mickyp.isaac3d"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
foreach ($d in @('CSXS', 'client', 'host')) {
    robocopy (Join-Path $src $d) (Join-Path $dst $d) /MIR /NJH /NJS /NFL /NDL | Out-Null
}
# .debug enables Chrome DevTools on localhost:8098 for the panel (harmless in production)
Copy-Item (Join-Path $src '.debug') (Join-Path $dst '.debug') -Force
Write-Host "Deployed to $dst"
Write-Host "In After Effects: Window > Extensions > Isaac3D  (close and reopen the panel if it was already open)"
