# Changelog

## 0.1.0

- 首版：新增 `view_image(path, maxWidth = 2000)`，把 JXL / AVIF / HEIC / HEIF / BMP / TIFF（以及 ImageMagick 存在时的 PSD）转成 PNG 后返回图像块。
- 两个解码面：libjxl / libavif 的命令行工具（`djxl` / `avifdec`）优先，Windows WIC（经 Windows PowerShell 5.1）兜底；WIC 单独就能覆盖 JXL / AVIF / WebP / BMP / TIFF。
- 缓存：键 = 规范化路径 + 大小 + 修改时间 + 长边上限 + 配方版本；落 `%TEMP%\dsh-view-image\`，超 7 天顺手清理。
- 只读：解码器只读源文件，所有写入都在缓存目录；离线自测对每个夹具做转换前后 sha256 比对。
- 失败可操作：缺解码器时说明缺谁与安装命令；PDF / 视频明确标注属于二期。
- 相对路径按会话工作目录解析；长边限幅只缩小不放大。
