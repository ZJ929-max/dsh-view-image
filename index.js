// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * dsh-view-image — `view_image`: read image formats the built-in `read_image`
 * cannot open (JXL / AVIF / HEIC / HEIF / BMP / TIFF, plus PSD through
 * ImageMagick) by converting them to PNG first.
 *
 * Nothing here changes DSH core code: the tool is registered through the normal
 * `ctx.tools` seam and returns its image the same way `read_image` does — one
 * durable attachment reference rendered as an `image` content block.
 *
 * Read-only by construction: decoders open the source for reading only, and every
 * byte this plugin writes lands in its own cache directory under the system temp.
 */

import path from 'node:path'
import { readFile } from 'node:fs/promises'

import {
  convertImage,
  DEFAULT_CONFIG,
  MAX_MAX_WIDTH,
  MIN_MAX_WIDTH,
  SUPPORTED_EXTENSIONS,
  ViewImageError,
} from './lib/convert.js'

export const inject = ['tools']

const TOOL_NAME = 'view_image'

/** Config keys the tool passes straight to the converter. */
const CONVERTER_KEYS = [
  'cacheDir',
  'codecDir',
  'timeoutMs',
  'maxSourceBytes',
  'cacheMaxAgeDays',
  'powershellPath',
]

function converterConfig(row) {
  const config = {}
  for (const key of CONVERTER_KEYS) {
    if (row[key] !== undefined && row[key] !== null) config[key] = row[key]
  }
  return config
}

function clampMaxWidth(value, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.min(MAX_MAX_WIDTH, Math.max(MIN_MAX_WIDTH, Math.round(numeric)))
}

/**
 * Refuse only when the resolved route explicitly declares non-image input.
 * Any failure while resolving is treated as "unknown" and does not block the read.
 */
async function assertImageCapableRoute(ctx, exec, displayPath) {
  const llm = ctx.get('llm')
  const agent = exec?.agent
  if (llm === undefined || agent === undefined) return
  let provider
  let model
  try {
    const routed = agent.session?.requestHeader?.()?.config
    provider = routed?.provider ?? agent.options?.provider
    model = routed?.model ?? agent.options?.model
  } catch {
    return
  }
  if (provider === undefined || model === undefined) return
  let info
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal)
  } catch {
    return
  }
  const modalities = info?.inputModalities
  if (Array.isArray(modalities) && !modalities.includes('image')) {
    throw new ViewImageError(
      `不能把 "${displayPath}" 当图像读：模型 ${model} 没有声明图像输入；换一个支持图像的模型再调用 view_image`,
      'E_MODEL_NO_IMAGE',
    )
  }
}

/**
 * The session's working directory, when the service can answer.
 * Any failure yields undefined and the caller keeps the raw path.
 */
function sessionCwd(ctx, exec) {
  try {
    const workingDirectory = ctx.get('workingDirectory')
    const session = exec?.agent?.session
    if (workingDirectory === undefined || session === undefined) return undefined
    const cwd = workingDirectory.get(session)
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

function formatViewOutput(value) {
  const image = value.image
  const source = value.source
  const ratio = image.width > 0 ? (source.width / image.width) : 1
  const downscaled = source.width !== image.width || source.height !== image.height
  const note = downscaled
    ? ` (downscaled from ${source.width}x${source.height} px; multiply coordinates by ${ratio.toFixed(2)} to locate features in the original file)`
    : ''
  return `<path>${value.path}</path>
<type>image</type>
<source>${source.format} ${source.width}x${source.height} px -> png ${image.width}x${image.height} px, via ${value.converter}${value.cacheHit ? ' (cache hit)' : ''}</source>
<content>
${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes${note}
</content>`
}

function imageContent(value) {
  const image = value.image
  return [
    { type: 'text', text: formatViewOutput(value) },
    {
      type: 'image',
      attachment: {
        attachmentId: image.attachmentId,
        mediaType: image.mediaType,
        bytes: image.bytes,
        width: image.width,
        height: image.height,
        ...(image.name === undefined ? {} : { name: image.name }),
        ...(image.originalDimensions === undefined ? {} : { originalDimensions: { ...image.originalDimensions } }),
      },
    },
  ]
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const row = config ?? {}
  const defaultMaxWidth = clampMaxWidth(row.defaultMaxWidth, DEFAULT_CONFIG.defaultMaxWidth)
  const convertOptions = converterConfig(row)

  const tool = {
    name: TOOL_NAME,
    description:
      '打开 read_image 读不了的本地图片，并把图像直接返回。'
      + 'read_image 报不支持、或者文件是 jxl / avif / heic / heif / bmp / tif / tiff 时用它；'
      + 'psd 需要 ImageMagick，缺了会说清装什么；png / jpg / webp / gif 仍用 read_image。'
      + '长边超过 maxWidth 先等比缩小（默认 2000，小字多的截图想保细节可给 8192），永不放大；'
      + '结果按「路径+修改时间+尺寸」缓存在临时目录，源文件只读不改。'
      + 'path 用绝对路径最稳，相对路径按当前会话工作目录解析。PDF 首页与视频抽帧属于二期，传进来会明确报错。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: `图片文件路径（相对路径按会话工作目录解析）。支持的扩展名：${SUPPORTED_EXTENSIONS.join(' ')}`,
        },
        maxWidth: {
          type: 'integer',
          description: `长边像素上限，默认 ${defaultMaxWidth}，范围 ${MIN_MAX_WIDTH}-${MAX_MAX_WIDTH}；只缩小不放大`,
        },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
              bytes: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              name: { type: 'string' },
              originalDimensions: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  width: { type: 'integer' },
                  height: { type: 'integer' },
                },
              },
            },
            required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
          },
          source: {
            type: 'object',
            additionalProperties: false,
            properties: {
              format: { type: 'string' },
              width: { type: 'integer' },
              height: { type: 'integer' },
            },
            required: ['format', 'width', 'height'],
          },
          converter: { type: 'string' },
          cacheHit: { type: 'boolean' },
        },
        required: ['path', 'image', 'source', 'converter', 'cacheHit'],
      },
      render: (_args, value) => imageContent(value),
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    // Content-addressed cache writes and attachment saves are idempotent.
    isConcurrencySafe: () => true,
    timeoutMs: 180_000,
    async execute(args, exec) {
      const rawPath = typeof args?.path === 'string' ? args.path.trim() : ''
      if (rawPath === '') throw new ViewImageError('path 不能为空', 'E_ARGS')
      const maxEdge = clampMaxWidth(args?.maxWidth, defaultMaxWidth)
      // A relative path means "relative to the session's working directory", which
      // is not this process's cwd; fall back to the process cwd when unavailable.
      const cwd = sessionCwd(ctx, exec)
      const filePath = cwd !== undefined && !path.isAbsolute(rawPath) ? path.resolve(cwd, rawPath) : rawPath

      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new ViewImageError('没有挂载附件服务，无法提交图像结果', 'E_NO_ATTACHMENTS')
      }
      await assertImageCapableRoute(ctx, exec, filePath)

      const converted = await convertImage({
        filePath,
        maxEdge,
        config: convertOptions,
        signal: exec?.signal,
      })

      const data = await readFile(converted.pngPath)
      let ref
      try {
        ref = await attachments.saveImage({
          data,
          mediaType: 'image/png',
          name: path.basename(converted.pngPath),
        })
      } catch (error) {
        const reason = error?.message ?? String(error)
        throw new ViewImageError(`PNG 已转好（${converted.pngPath}），但附件库拒收：${reason}`, 'E_ATTACHMENT_REJECTED')
      }

      const downscaled = converted.sourceWidth !== converted.width || converted.sourceHeight !== converted.height
      return {
        path: filePath,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
          ...(downscaled ? { originalDimensions: { width: converted.sourceWidth, height: converted.sourceHeight } } : {}),
        },
        source: {
          format: converted.format,
          width: converted.sourceWidth,
          height: converted.sourceHeight,
        },
        converter: converted.converter,
        cacheHit: converted.cacheHit,
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `View image ${args?.path ?? ''}`,
        kind: 'read',
        locations: [{ path: String(args?.path ?? '') }],
      }
    },
  }

  ctx.effect(() => ctx.tools.register(tool))
}
