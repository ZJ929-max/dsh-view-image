# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# dsh-view-image / lib/wic.ps1
#
# Decode one image through Windows Imaging Component (System.Windows.Media.Imaging),
# normalize it to 8-bit sRGB, scale its long edge down to -MaxEdge when needed, and
# write a PNG. Read-only with respect to -In: the source is opened with
# BitmapCacheOption.OnLoad and never written back.
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File wic.ps1 `
#       -In <source> -Out <png> -MaxEdge 2000
#
# Exit codes
#   0  wrote the PNG; stdout carries "<w>x<h> src=<sw>x<sh> codec=<name>"
#   2  the source could not be decoded by any installed WIC codec
#   3  the PNG could not be encoded (or written)
#   4  WIC itself is unavailable (no PresentationCore in this PowerShell)
#
# stderr always carries exactly one line, prefixed with the same code as the exit.

param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxEdge = 2000
)

$ErrorActionPreference = 'Stop'

function Fail([int]$code, [string]$kind, [string]$message) {
  $oneLine = ($message -replace '\s+', ' ').Trim()
  [Console]::Error.WriteLine("$kind`: $oneLine")
  exit $code
}

try {
  Add-Type -AssemblyName PresentationCore
} catch {
  Fail 4 'WIC_UNAVAILABLE' $_.Exception.Message
}

if (-not (Test-Path -LiteralPath $In -PathType Leaf)) {
  Fail 2 'DECODE_FAILED' "no such file: $In"
}

$decoder = $null
try {
  $decoder = [System.Windows.Media.Imaging.BitmapDecoder]::Create(
    $In,
    [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat,
    [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
} catch {
  $message = $_.Exception.Message
  if ($_.Exception.InnerException) { $message = $_.Exception.InnerException.Message }
  Fail 2 'DECODE_FAILED' $message
}

$codec = ''
try { $codec = $decoder.CodecInfo.FriendlyName } catch { $codec = 'unknown' }

if ($decoder.Frames.Count -lt 1) {
  Fail 2 'DECODE_FAILED' "the file holds no image frame ($codec)"
}

$frame = $decoder.Frames[0]
$srcWidth = $frame.PixelWidth
$srcHeight = $frame.PixelHeight

# Normalize to 8-bit Bgra32: 16-bit / CMYK / indexed sources cannot be scaled or
# encoded by TransformedBitmap or PngBitmapEncoder reliably, and the attachment
# store wants 8-bit sRGB anyway.
$work = $frame
try {
  $work = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap(
    $frame, [System.Windows.Media.PixelFormats]::Bgra32, $null, 0)
} catch {
  # Keep the original frame: some sources already report an encodable format.
  $work = $frame
}

$longEdge = [Math]::Max($srcWidth, $srcHeight)
if ($MaxEdge -gt 0 -and $longEdge -gt $MaxEdge) {
  $scale = [double]$MaxEdge / [double]$longEdge
  try {
    $transform = New-Object System.Windows.Media.ScaleTransform($scale, $scale)
    $work = New-Object System.Windows.Media.Imaging.TransformedBitmap($work, $transform)
  } catch {
    Fail 3 'ENCODE_FAILED' "scaling failed: $($_.Exception.Message)"
  }
}

$outWidth = $work.PixelWidth
$outHeight = $work.PixelHeight

$stream = $null
try {
  $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($work))
  $stream = [System.IO.File]::Create($Out)
  $encoder.Save($stream)
} catch {
  $message = $_.Exception.Message
  if ($_.Exception.InnerException) { $message = $_.Exception.InnerException.Message }
  Fail 3 'ENCODE_FAILED' $message
} finally {
  if ($stream -ne $null) { $stream.Close() }
}

[Console]::Out.WriteLine("$outWidth`x$outHeight src=$srcWidth`x$srcHeight codec=$codec")
exit 0
