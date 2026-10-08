# Runs only on the disposable Windows CI host. No provider, account or model call is made.
$ErrorActionPreference = 'Stop'
$distro = 'Ubuntu-24.04'

function Invoke-Wsl([string[]] $Arguments) {
    & wsl.exe --distribution $distro --user cyberdeck-ci -- @Arguments
    if ($LASTEXITCODE -ne 0) { throw "WSL command failed with exit code $LASTEXITCODE" }
}

& wsl.exe --set-default-version 2
if ($LASTEXITCODE -ne 0) { throw 'Could not select WSL2' }
& wsl.exe --install --web-download --distribution $distro --no-launch
if ($LASTEXITCODE -ne 0) { throw 'Could not install the WSL distribution' }

$setup = @'
set -euo pipefail
uname -r | grep -qi 'microsoft.*wsl2'
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y build-essential python3 curl ca-certificates git tmux zsh
useradd --create-home --shell /bin/bash cyberdeck-ci
source_path=$(wslpath -u "$1")
cp -a "$source_path" /home/cyberdeck-ci/source
chown -R cyberdeck-ci:cyberdeck-ci /home/cyberdeck-ci/source
'@
$setupFile = Join-Path $env:RUNNER_TEMP 'cyberdeck-wsl-setup.sh'
[IO.File]::WriteAllText($setupFile, ($setup -replace "`r", ''), [Text.UTF8Encoding]::new($false))
$linuxSetup = (& wsl.exe --distribution $distro --user root -- wslpath -u $setupFile).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not map the setup script into WSL' }
& wsl.exe --distribution $distro --user root -- bash $linuxSetup $env:GITHUB_WORKSPACE
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the disposable Linux workspace' }

Invoke-Wsl -Arguments @('bash', '/home/cyberdeck-ci/source/scripts/verify-wsl-install.sh')

# Both PowerShell and Cyberdeck run in this CI Windows user's desktop session. The clipboard
# payload is a disposable 3x2 image, never provider data or an operator's screenshot.
$clear = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()'
$setImage = @'
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$image = New-Object System.Drawing.Bitmap 3,2
try {
  $image.SetPixel(0, 0, [System.Drawing.Color]::Red)
  [System.Windows.Forms.Clipboard]::SetDataObject($image, $true)
} finally { $image.Dispose() }
'@
foreach ($phase in @('empty', 'image')) {
    $fixture = if ($phase -eq 'empty') { $clear } else { $setImage }
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($fixture))
    & powershell.exe -NoLogo -NoProfile -NonInteractive -STA -EncodedCommand $encoded
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the Windows clipboard fixture' }
    Invoke-Wsl -Arguments @('/home/cyberdeck-ci/node/bin/node', '/home/cyberdeck-ci/source/scripts/verify-wsl-clipboard.mjs', $phase)
}
