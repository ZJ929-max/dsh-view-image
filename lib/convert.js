// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * dsh-view-image / lib/convert.js
 *
 * Turn any locally supported image into an 8-bit sRGB PNG inside a cache
 * directory, without touching the source file.
 *
 * Two decoders are used, in this order per format:
 *   - the command-line codecs already installed on this machine (djxl, avifdec);
 *   - Windows Imaging Component through Windows PowerShell (wic.ps1), which on
 *     this machine decodes JXL, AVIF/HEIF, WebP, BMP, TIFF, PNG, JPEG and GIF.
 *
 * This module has no dependency on the Harness runtime, so it can be exercised
 * directly with `ELECTRON_RUN_AS_NODE=1 node test/convert.test.mjs`.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Bumped whenever the conversion recipe changes, so old cache entries age out. */
export const CACHE_VERSION = 2

export const DEFAULT_CONFIG = Object.freeze({
  /** Cache root; defaults to `<system temp>/dsh-view-image`. */
  cacheDir: null,
  /** Where the command-line codecs live; `null` means "PATH only". */
  codecDir: 'C:\\dev\\tools\\codecs',
  /** Upper bound for one external decoder run. */
  timeoutMs: 120_000,
  /** Refuse sources larger than this before handing them to a decoder. */
  maxSourceBytes: 512 * 1024 * 1024,
  /** Cache entries older than this many days are pruned opportunistically. */
  cacheMaxAgeDays: 7,
  /** Default long-edge cap when the caller does not pass `maxWidth`. */
  defaultMaxWidth: 2000,
  /** Override the PowerShell executable; `null` uses Windows PowerShell 5.1. */
  powershellPath: null,
})

/** Long-edge floor/ceiling, so a hostile `maxWidth` cannot ask for a 1px or 100k-px image. */
export const MIN_MAX_WIDTH = 64
export const MAX_MAX_WIDTH = 8192

export const SUPPORTED_EXTENSIONS = Object.freeze([
  '.jxl', '.avif', '.heic', '.heif', '.bmp', '.tif', '.tiff',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.psd',
])

/** A conversion failure with a machine-readable code and an actionable message. */
export class ViewImageError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ViewImageError'
    this.code = code
  }
}

/* ------------------------------------------------------------------ */
/* format detection                                                    */
/* ------------------------------------------------------------------ */

function ascii(bytes, offset, value) {
  if (bytes.length < offset + value.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

function ftypBrand(bytes) {
  if (!ascii(bytes, 4, 'ftyp')) return undefined
  return Buffer.from(bytes.subarray(8, 12)).toString('latin1')
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'])
const HEIF_BRANDS = new Set(['mif1', 'msf1'])

/**
 * Identify the format from the file signature.
 * @param {Uint8Array} bytes - at least the first 16 bytes of the file.
 * @returns {string | undefined} a format key, or undefined for unrecognized bytes.
 */
export function detectFormat(bytes) {
  if (bytes.length >= 12 && bytes[0] === 0x89 && ascii(bytes, 1, 'PNG')) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'gif'
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'webp'
  if (ascii(bytes, 0, 'BM')) return 'bmp'
  if (ascii(bytes, 0, 'II*\0') || ascii(bytes, 0, 'MM\0*')) return 'tiff'
  if (ascii(bytes, 0, '8BPS')) return 'psd'
  if (ascii(bytes, 4, 'JXL ') || (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0x0a)) return 'jxl'
  const brand = ftypBrand(bytes)
  if (brand !== undefined) {
    if (brand === 'avif' || brand === 'avis') return 'avif'
    if (HEIC_BRANDS.has(brand)) return 'heic'
    if (HEIF_BRANDS.has(brand)) return 'heif'
  }
  return undefined
}

const EXTENSION_FORMATS = Object.freeze({
  '.jxl': 'jxl',
  '.avif': 'avif',
  '.heic': 'heic',
  '.heif': 'heif',
  '.bmp': 'bmp',
  '.tif': 'tiff',
  '.tiff': 'tiff',
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.gif': 'gif',
  '.webp': 'webp',
  '.psd': 'psd',
})

/** How each format is attempted, in order. */
const PLANS = Object.freeze({
  jxl: [{ cli: 'djxl' }, { wic: true }],
  avif: [{ cli: 'avifdec' }, { wic: true }],
  heic: [{ wic: true }, { cli: 'avifdec' }],
  heif: [{ wic: true }, { cli: 'avifdec' }],
  bmp: [{ wic: true }],
  tiff: [{ wic: true }],
  png: [{ wic: true }],
  jpeg: [{ wic: true }],
  gif: [{ wic: true }],
  webp: [{ wic: true }],
  psd: [{ magick: true }],
})

/* ------------------------------------------------------------------ */
/* PNG header                                                          */
/* ------------------------------------------------------------------ */

/**
 * Read width/height out of a PNG IHDR, which also proves the file really is a PNG.
 * @param {string} file - path to the candidate PNG.
 * @returns {Promise<{ width: number, height: number }>}
 * @throws {ViewImageError} `E_BAD_OUTPUT` when the bytes are not a valid PNG header.
 */
export async function readPngSize(file) {
  const handle = await fs.open(file, 'r')
  try {
    const header = Buffer.alloc(33)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead < 33) throw new ViewImageError('转换产物不是完整 PNG（文件太短）', 'E_BAD_OUTPUT')
    const signatureOk = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47
    if (!signatureOk || header.toString('latin1', 12, 16) !== 'IHDR') {
      throw new ViewImageError('转换产物不是合法 PNG（文件头不符）', 'E_BAD_OUTPUT')
    }
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
  } finally {
    await handle.close()
  }
}

/* ------------------------------------------------------------------ */
/* cache                                                               */
/* ------------------------------------------------------------------ */

/**
 * Cache file name for one source at one long-edge cap.
 * Keyed on the resolved path, size, modification time and the cap, so editing a
 * file invalidates its entry while a second read of the same bytes is free.
 * @returns {string} hex digest, no extension.
 */
export function cacheKey(realPath, size, mtimeMs, maxEdge) {
  return createHash('sha256')
    .update(`${realPath}\u0000${size}\u0000${Math.round(mtimeMs)}\u0000${maxEdge}\u0000v${CACHE_VERSION}`)
    .digest('hex')
    .slice(0, 40)
}

function cacheDir(config) {
  return config.cacheDir ?? path.join(os.tmpdir(), 'dsh-view-image')
}

async function pruneCache(dir, maxAgeDays) {
  if (!(maxAgeDays > 0)) return
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.png')) continue
      const file = path.join(dir, entry.name)
      try {
        const stat = await fs.stat(file)
        if (stat.mtimeMs < cutoff) {
          await fs.rm(file, { force: true })
          await fs.rm(`${file}.json`, { force: true })
        }
      } catch {
        /* a cache entry that cannot be inspected is not worth a failure */
      }
    }
  } catch {
    /* pruning is opportunistic */
  }
}

/* ------------------------------------------------------------------ */
/* external processes                                                  */
/* ------------------------------------------------------------------ */

function resolveOnPath(name, config) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  if (config.codecDir) {
    const candidate = path.join(config.codecDir, exe)
    if (existsSync(candidate)) return candidate
  }
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue
    const candidate = path.join(dir, exe)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function powershellPath(config) {
  if (config.powershellPath) return config.powershellPath
  // Windows PowerShell 5.1, not pwsh: the WPF imaging stack lives in .NET Framework.
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const candidate = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(candidate) ? candidate : 'powershell.exe'
}

const WIC_SCRIPT = fileURLToPath(new URL('./wic.ps1', import.meta.url))

function runProcess(exe, args, { timeoutMs, signal, ioDir }) {
  return new Promise((resolve) => {
    const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    const outFile = path.join(ioDir, `exec-${stamp}.out`)
    const errFile = path.join(ioDir, `exec-${stamp}.err`)
    let outHandle
    let errHandle
    let child
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
      for (const handle of [outHandle, errHandle]) {
        if (handle) handle.close().catch(() => {})
      }
      fs.rm(outFile, { force: true }).catch(() => {})
      fs.rm(errFile, { force: true }).catch(() => {})
    }
    // File-backed stdio rather than pipes: DSH's Windows sandbox refuses named
    // pipes, and a plain file descriptor works in both worlds.
    ;(async () => {
      try {
        outHandle = await fs.open(outFile, 'w')
        errHandle = await fs.open(errFile, 'w')
      } catch (error) {
        finish({ code: -1, stdout: '', stderr: `cannot create decoder stdio files: ${error?.message}`, timedOut: false })
        return
      }
      const readBack = async (file) => {
        try {
          return (await fs.readFile(file, 'utf8')).slice(-8000)
        } catch {
          return ''
        }
      }
      const readBoth = async (code, timedOut) => {
        const [stdout, stderr] = await Promise.all([readBack(outFile), readBack(errFile)])
        finish({ code, stdout, stderr: stderr.trim(), timedOut })
      }
      try {
        child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', outHandle.fd, errHandle.fd] })
      } catch (error) {
        finish({ code: -1, stdout: '', stderr: error?.message ?? String(error), timedOut: false })
        return
      }
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, timeoutMs)
      const onAbort = () => child.kill()
      signal?.addEventListener('abort', onAbort, { once: true })
      const done = (code, extra) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        readBoth(code, timedOut).then((result) => {
          if (extra) result.stderr = `${result.stderr} ${extra}`.trim()
        })
      }
      child.on('error', (error) => done(-1, error?.message))
      child.on('close', (code) => done(code ?? -1))
    })()
  })
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
}

/* ------------------------------------------------------------------ */
/* converters                                                          */
/* ------------------------------------------------------------------ */

async function runWic(source, destination, maxEdge, config, signal) {
  const result = await runProcess(
    powershellPath(config),
    [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', WIC_SCRIPT,
      '-In', source,
      '-Out', destination,
      '-MaxEdge', String(maxEdge),
    ],
    { timeoutMs: config.timeoutMs, signal, ioDir: config.ioDir },
  )
  if (result.timedOut) throw new ViewImageError(`WIC 解码超时（>${config.timeoutMs}ms）`, 'E_TIMEOUT')
  if (result.code !== 0) {
    const detail = oneLine(result.stderr.replace(/^[A-Z_]+:\s*/, ''))
    throw new ViewImageError(`WIC 解码失败${detail ? `：${detail}` : ''}`, result.code === -1 ? 'E_MISSING_DECODER' : 'E_DECODE_FAILED')
  }
  // wic.ps1 prints "<out> src=<in>" so the downscale ratio can be reported.
  const match = /src=(\d+)x(\d+)/.exec(result.stdout)
  return {
    sourceWidth: match ? Number(match[1]) : undefined,
    sourceHeight: match ? Number(match[2]) : undefined,
  }
}

async function runCli(codecName, source, destination, config, signal) {
  const exe = resolveOnPath(codecName, config)
  if (exe === null) {
    throw new ViewImageError(
      `未找到 ${codecName}.exe（既不在 PATH，也不在 codecDir=${config.codecDir ?? '(未配置)'}）`,
      'E_MISSING_DECODER',
    )
  }
  const result = await runProcess(exe, [source, destination], { timeoutMs: config.timeoutMs, signal, ioDir: config.ioDir })
  if (result.timedOut) throw new ViewImageError(`${codecName} 解码超时（>${config.timeoutMs}ms）`, 'E_TIMEOUT')
  if (result.code !== 0) {
    throw new ViewImageError(`${codecName} 解码失败（exit ${result.code}）：${oneLine(result.stderr)}`, 'E_DECODE_FAILED')
  }
}

async function runMagick(source, destination, maxEdge, config, signal) {
  const exe = resolveOnPath('magick', { ...config, codecDir: null })
  if (exe === null) {
    throw new ViewImageError(
      '未找到 ImageMagick（magick.exe）。装它：winget install --id ImageMagick.ImageMagick -e；'
      + '或者先把文件导出成 PNG/TIFF 再读',
      'E_MISSING_DECODER',
    )
  }
  const result = await runProcess(
    exe,
    [`${source}[0]`, '-depth', '8', '-resize', `${maxEdge}x${maxEdge}>`, `PNG:${destination}`],
    { timeoutMs: config.timeoutMs, signal, ioDir: config.ioDir },
  )
  if (result.code !== 0) {
    throw new ViewImageError(`ImageMagick 转换失败（exit ${result.code}）：${oneLine(result.stderr)}`, 'E_DECODE_FAILED')
  }
}

/* ------------------------------------------------------------------ */
/* public entry                                                        */
/* ------------------------------------------------------------------ */

/**
 * Convert one image file into a cached PNG.
 *
 * @param {object} options
 * @param {string} options.filePath - the file to read; never modified.
 * @param {number} [options.maxEdge] - long-edge cap in pixels; 0 disables scaling.
 * @param {object} [options.config] - any `DEFAULT_CONFIG` overrides.
 * @param {AbortSignal} [options.signal] - cancels in-flight decoder runs.
 * @returns {Promise<{
 *   pngPath: string, width: number, height: number,
 *   sourceWidth: number, sourceHeight: number,
 *   format: string, cacheHit: boolean, converter: string,
 * }>}
 * @throws {ViewImageError} with an actionable message for every failure mode.
 */
export async function convertImage({ filePath, maxEdge = DEFAULT_CONFIG.defaultMaxWidth, config: overrides = {}, signal }) {
  const config = { ...DEFAULT_CONFIG, ...overrides }
  const cap = Number.isFinite(maxEdge) && maxEdge > 0 ? Math.round(maxEdge) : 0

  let realPath
  let stat
  try {
    realPath = await fs.realpath(filePath)
  } catch {
    throw new ViewImageError(`找不到文件：${filePath}`, 'E_NO_FILE')
  }
  try {
    stat = await fs.stat(realPath)
  } catch {
    throw new ViewImageError(`无法读取文件属性：${filePath}`, 'E_NO_FILE')
  }
  if (!stat.isFile()) throw new ViewImageError(`${filePath} 是目录，不是文件`, 'E_NOT_FILE')
  if (stat.size > config.maxSourceBytes) {
    throw new ViewImageError(
      `文件 ${(stat.size / 1024 / 1024).toFixed(1)} MB，超过上限 ${(config.maxSourceBytes / 1024 / 1024).toFixed(0)} MB；先降采样再读`,
      'E_TOO_LARGE',
    )
  }

  const handle = await fs.open(realPath, 'r')
  let head
  try {
    head = Buffer.alloc(32)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    head = head.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }

  const format = detectFormat(head) ?? EXTENSION_FORMATS[path.extname(realPath).toLowerCase()]
  if (format === undefined) {
    const extension = path.extname(filePath).toLowerCase() || '(无扩展名)'
    const phaseTwo = ['.pdf', '.mp4', '.webm', '.mov', '.mkv'].includes(extension)
    throw new ViewImageError(
      phaseTwo
        ? `${extension} 属于二期（PDF 首页 / 视频抽帧），这个版本还没实现`
        : `不支持 ${extension}：文件头也不是已知格式。可读的扩展名：${SUPPORTED_EXTENSIONS.join(' ')}`,
      'E_UNSUPPORTED_FORMAT',
    )
  }

  const dir = cacheDir(config)
  await fs.mkdir(dir, { recursive: true })
  config.ioDir = dir
  const key = cacheKey(realPath, stat.size, stat.mtimeMs, cap)
  const finalPath = path.join(dir, `${key}.png`)
  const metaPath = `${finalPath}.json`

  if (existsSync(finalPath)) {
    try {
      const { width, height } = await readPngSize(finalPath)
      let meta = {}
      try {
        meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
      } catch {
        meta = {}
      }
      return {
        pngPath: finalPath,
        width,
        height,
        sourceWidth: Number.isInteger(meta.sourceWidth) ? meta.sourceWidth : width,
        sourceHeight: Number.isInteger(meta.sourceHeight) ? meta.sourceHeight : height,
        bytes: (await fs.stat(finalPath)).size,
        format,
        cacheHit: true,
        converter: typeof meta.converter === 'string' ? meta.converter : 'cache',
      }
    } catch {
      await fs.rm(finalPath, { force: true })
      await fs.rm(metaPath, { force: true })
    }
  }

  const plan = PLANS[format] ?? [{ wic: true }]
  const attempts = []
  const stamp = `${process.pid}.${Date.now()}`
  const scratch = path.join(dir, `${key}.${stamp}.raw.png`)
  const staging = path.join(dir, `${key}.${stamp}.tmp.png`)

  try {
    for (const step of plan) {
      try {
        let wicInfo = {}
        if (step.cli) {
          await fs.rm(scratch, { force: true })
          await runCli(step.cli, realPath, scratch, config, signal)
          // The codecs emit a full-size PNG; WIC normalizes it and applies the cap.
          wicInfo = await runWic(scratch, staging, cap, config, signal)
        } else if (step.wic) {
          await fs.rm(staging, { force: true })
          wicInfo = await runWic(realPath, staging, cap, config, signal)
        } else if (step.magick) {
          await fs.rm(staging, { force: true })
          await runMagick(realPath, staging, cap, config, signal)
        }
        const { width, height } = await readPngSize(staging)
        try {
          await fs.rename(staging, finalPath)
        } catch {
          await fs.rm(finalPath, { force: true })
          await fs.rename(staging, finalPath)
        }
        const converter = step.cli ? `${step.cli}+wic` : step.magick ? 'magick' : 'wic'
        const meta = {
          format,
          converter,
          sourceWidth: wicInfo.sourceWidth ?? width,
          sourceHeight: wicInfo.sourceHeight ?? height,
          maxEdge: cap,
        }
        await fs.writeFile(metaPath, JSON.stringify(meta), 'utf8').catch(() => {})
        void pruneCache(dir, config.cacheMaxAgeDays)
        const pngSize = await fs.stat(finalPath)
        return {
          pngPath: finalPath,
          width,
          height,
          sourceWidth: meta.sourceWidth,
          sourceHeight: meta.sourceHeight,
          bytes: pngSize.size,
          format,
          cacheHit: false,
          converter,
        }
      } catch (error) {
        attempts.push(`${step.cli ?? (step.magick ? 'magick' : 'wic')}: ${error instanceof Error ? error.message : String(error)}`)
        if (error instanceof ViewImageError && error.code === 'E_TIMEOUT') break
      }
    }
  } finally {
    await fs.rm(scratch, { force: true }).catch(() => {})
    await fs.rm(staging, { force: true }).catch(() => {})
  }

  // One attempt can miss a binary while a later one fails for another reason, so
  // the install advice rides along whenever the format has one. PSD keeps no extra
  // hint: its own attempt already names ImageMagick and the install command.
  const missing = attempts.some((entry) => /未找到|not found|no such/iu.test(entry))
  const HINTS = {
    jxl: '确认 libjxl 的 djxl.exe 在 PATH 或 codecDir 里，或安装「JPEG XL 图像扩展」',
    avif: '确认 libavif 的 avifdec.exe 在 PATH 或 codecDir 里，或安装系统的 AV1 图像扩展',
    heic: 'HEIC/HEIF 需要系统的「HEIF 图像扩展」；也可以用 avifdec 转换后再读',
    heif: 'HEIC/HEIF 需要系统的「HEIF 图像扩展」；也可以用 avifdec 转换后再读',
  }
  const hint = HINTS[format] ?? (format === 'psd' ? '' : '检查文件是否完整，或换一个解码器')
  throw new ViewImageError(
    `无法解码 ${path.basename(realPath)}（格式 ${format}）：${attempts.join('；') || '没有可用的解码器'}${hint ? `。${hint}` : ''}`,
    missing ? 'E_MISSING_DECODER' : 'E_DECODE_FAILED',
  )
}
