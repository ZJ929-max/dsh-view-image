/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * dsh-view-image / test/convert.test.mjs
 *
 * Offline checks for lib/convert.js — no Harness runtime, no model call.
 * Run with:
 *   $env:ELECTRON_RUN_AS_NODE=1; & $env:DSH_NODE_EXECUTABLE test/convert.test.mjs
 *
 * Environment:
 *   VIEW_IMAGE_STATIC=1        only format/key/error checks that never spawn a decoder
 *   VIEW_IMAGE_FIXTURES=<dir>  fixture directory (default <temp>\\view-image-fixtures)
 *   VIEW_IMAGE_JXL=<dir>       optional real .jxl/.avif samples; the JXL/AVIF
 *                              conversion cases SKIP when they are absent
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  cacheKey,
  convertImage,
  detectFormat,
  readPngSize,
  ViewImageError,
} from '../lib/convert.js'

const STATIC = process.env.VIEW_IMAGE_STATIC === '1'
const FIXTURES = process.env.VIEW_IMAGE_FIXTURES ?? path.join(os.tmpdir(), 'view-image-fixtures')
// Real JXL/AVIF samples are machine-specific and never committed; point this at a
// directory holding `jxl-d3.jxl` and `avif-q63.avif` to cover those decoders.
const JXL_DIR = process.env.VIEW_IMAGE_JXL ?? ''
const CACHE = path.join(os.tmpdir(), 'view-image-cache-test')

let passed = 0
let failed = 0
let skipped = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function skip(name, why) {
  skipped += 1
  console.log(`SKIP  ${name} (${why})`)
}

async function exists(file) {
  return fs.stat(file).then(() => true, () => false)
}

async function hashFile(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

async function errorOf(fn) {
  try {
    await fn()
    return undefined
  } catch (error) {
    return error
  }
}

async function main() {
  // --- format sniffing (portable) ---------------------------------------
  const samples = {
    png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]),
    gif: Buffer.from('GIF89a............'),
    webp: Buffer.from('RIFF\0\0\0\0WEBPVP8 '),
    bmp: Buffer.from('BM\0\0\0\0\0\0\0\0'),
    tiff: Buffer.from('II*\0\0\0\0\0\0\0'),
    psd: Buffer.from('8BPS\0\x01\0\0'),
    jxl: Buffer.from('....JXL \r\n\x87\n'),
    avif: Buffer.from('\0\0\0\x20ftypavifavifmif1'),
    heic: Buffer.from('\0\0\0\x20ftypheicmif1'),
    heif: Buffer.from('\0\0\0\x20ftypmif1mif1'),
  }
  for (const [expected, bytes] of Object.entries(samples)) {
    check(`detectFormat ${expected}`, detectFormat(bytes) === expected, `got ${detectFormat(bytes)}`)
  }
  check('detectFormat unknown', detectFormat(Buffer.from('not an image at all')) === undefined)

  // --- cache key (portable) ---------------------------------------------
  const k1 = cacheKey('C:\\a\\b.png', 100, 1000, 2000)
  check('cacheKey stable', k1 === cacheKey('C:\\a\\b.png', 100, 1000, 2000))
  check('cacheKey changes with mtime', k1 !== cacheKey('C:\\a\\b.png', 100, 1001, 2000))
  check('cacheKey changes with cap', k1 !== cacheKey('C:\\a\\b.png', 100, 1000, 800))

  await fs.rm(CACHE, { recursive: true, force: true })
  const config = { cacheDir: CACHE }

  // --- error paths (no decoder is spawned) ------------------------------
  const missing = await errorOf(() => convertImage({ filePath: path.join(FIXTURES, 'nope.jxl'), config }))
  check('missing file -> E_NO_FILE', missing?.code === 'E_NO_FILE', missing?.message)

  if (await exists(path.join(FIXTURES, 'notanimage.txt'))) {
    const unsupported = await errorOf(() => convertImage({ filePath: path.join(FIXTURES, 'notanimage.txt'), config }))
    check('unsupported -> E_UNSUPPORTED_FORMAT', unsupported?.code === 'E_UNSUPPORTED_FORMAT', unsupported?.message)
  } else {
    skip('unsupported format', 'fixture missing — run test/make-fixtures.ps1')
  }

  if (await exists(path.join(FIXTURES, 'fake.psd'))) {
    const psdError = await errorOf(() => convertImage({ filePath: path.join(FIXTURES, 'fake.psd'), maxEdge: 400, config }))
    check('psd errors instead of crashing', psdError instanceof ViewImageError)
    check('psd error names ImageMagick', Boolean(psdError && /ImageMagick/.test(psdError.message)), psdError?.message)
  } else {
    skip('psd error path', 'fixture missing — run test/make-fixtures.ps1')
  }

  if (STATIC) {
    console.log('\nVIEW_IMAGE_STATIC=1 — decoder cases skipped (this host may not have WIC)')
  } else {
    // --- jxl / avif: only when real samples are available ----------------
    const jxl = path.join(JXL_DIR, 'jxl-d3.jxl')
    if (await exists(jxl)) {
      const jxlHash = await hashFile(jxl)
      const first = await convertImage({ filePath: jxl, maxEdge: 800, config })
      check('jxl converts', first.width === 800 && first.height === 500, `${first.width}x${first.height}`)
      check('jxl reports source size', first.sourceWidth === 2558 && first.sourceHeight === 1598, `${first.sourceWidth}x${first.sourceHeight}`)
      check('jxl first call is not cached', first.cacheHit === false)
      const png = await readPngSize(first.pngPath)
      check('jxl output is a png', png.width === first.width)
      const second = await convertImage({ filePath: jxl, maxEdge: 800, config })
      check('jxl second call is cached', second.cacheHit === true && second.pngPath === first.pngPath)
      check('jxl source untouched', (await hashFile(jxl)) === jxlHash)

      const big = await convertImage({ filePath: jxl, maxEdge: 4000, config })
      check('never upscales', big.width === 2558 && big.height === 1598, `${big.width}x${big.height}`)
    } else {
      skip('jxl conversion', `no sample at ${JXL_DIR} (set VIEW_IMAGE_JXL)`)
      skip('never upscales', 'needs a sample larger than the cap')
    }

    const avif = path.join(JXL_DIR, 'avif-q63.avif')
    if (await exists(avif)) {
      const avifHash = await hashFile(avif)
      const avifOut = await convertImage({ filePath: avif, maxEdge: 1000, config })
      check('avif converts', avifOut.width === 1000 && avifOut.height > 0, `${avifOut.width}x${avifOut.height}`)
      check('avif source untouched', (await hashFile(avif)) === avifHash)
    } else {
      skip('avif conversion', `no sample at ${JXL_DIR} (set VIEW_IMAGE_JXL)`)
    }

    // --- bmp / tiff through WIC -----------------------------------------
    for (const name of ['sample.bmp', 'sample.tiff']) {
      const file = path.join(FIXTURES, name)
      if (!(await exists(file))) {
        skip(`${name} conversion`, 'fixture missing — run test/make-fixtures.ps1')
        continue
      }
      const before = await hashFile(file)
      const out = await convertImage({ filePath: file, maxEdge: 160, config })
      check(`${name} converts`, out.width === 160 && out.height > 0, `${out.width}x${out.height}`)
      check(`${name} source untouched`, (await hashFile(file)) === before)
    }
  }

  // --- cache hygiene -----------------------------------------------------
  if (await exists(CACHE)) {
    const cacheFiles = await fs.readdir(CACHE)
    check(
      'no staging leftovers',
      cacheFiles.every((f) => f.endsWith('.png') || f.endsWith('.png.json')),
      cacheFiles.join(', '),
    )
  }

  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failed} failed, ${skipped} skipped`)
  process.exitCode = failed === 0 ? 0 : 1
}

await main()
