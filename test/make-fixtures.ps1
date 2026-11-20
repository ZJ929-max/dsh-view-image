# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Generate the binary fixtures the offline suite needs, without downloading
# anything and without committing binaries: a 320x200 gradient is drawn with
# Windows Imaging Component and encoded into PNG / BMP / TIFF, then a fake PSD
# header and a plain-text file are written for the error paths.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/make-fixtures.ps1 `
#       -Out "$env:TEMP\view-image-fixtures"

param(
  [string]$Out = (Join-Path $env:TEMP 'view-image-fixtures'),
  [int]$Width = 320,
  [int]$Height = 200
)

$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path $Out | Out-Null

try {
  Add-Type -AssemblyName PresentationCore
} catch {
  [Console]::Error.WriteLine("WIC_UNAVAILABLE: $($_.Exception.Message)")
  exit 4
}

# A diagonal gradient with an opaque alpha channel, so a wrong channel order or a
# dropped alpha shows up in the converted PNG.
$stride = $Width * 4
$pixels = New-Object byte[] ($stride * $Height)
for ($y = 0; $y -lt $Height; $y++) {
  for ($x = 0; $x -lt $Width; $x++) {
    $offset = $y * $stride + $x * 4
    $pixels[$offset] = [byte](255 * $y / ($Height - 1))       # B
    $pixels[$offset + 1] = [byte](255 * $x / ($Width - 1))    # G
    $pixels[$offset + 2] = [byte]128                          # R
    $pixels[$offset + 3] = [byte]255                          # A
  }
}

$source = [System.Windows.Media.Imaging.BitmapSource]::Create(
  $Width, $Height, 96, 96,
  [System.Windows.Media.PixelFormats]::Bgra32, $null, $pixels, $stride)

function Save-Bitmap([string]$path, $encoder) {
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($source))
  $stream = [System.IO.File]::Create($path)
  try {
    $encoder.Save($stream)
  } finally {
    $stream.Close()
  }
  Write-Host "wrote $path"
}

Save-Bitmap (Join-Path $Out 'sample.png') (New-Object System.Windows.Media.Imaging.PngBitmapEncoder)
Save-Bitmap (Join-Path $Out 'sample.bmp') (New-Object System.Windows.Media.Imaging.BmpBitmapEncoder)
Save-Bitmap (Join-Path $Out 'sample.tiff') (New-Object System.Windows.Media.Imaging.TiffBitmapEncoder)

# A PSD only needs to reach the "no ImageMagick" branch; the bytes are a valid
# signature followed by zeros.
$fakePsd = New-Object byte[] 64
$fakePsd[0] = 0x38
$fakePsd[1] = 0x42
$fakePsd[2] = 0x50
$fakePsd[3] = 0x53
[System.IO.File]::WriteAllBytes((Join-Path $Out 'fake.psd'), $fakePsd)
Write-Host "wrote $(Join-Path $Out 'fake.psd')"

Set-Content -LiteralPath (Join-Path $Out 'notanimage.txt') -Value 'this is not an image' -Encoding UTF8
Write-Host "wrote $(Join-Path $Out 'notanimage.txt')"

exit 0
