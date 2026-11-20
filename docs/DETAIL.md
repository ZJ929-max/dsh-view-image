# 看图（更多格式）

DSH 内置的 `read_image` 只认得 PNG / JPEG / WebP / GIF。这个插件补上其余常见格式：新增工具 `view_image(path, maxWidth = 2000)`，先把文件转成 PNG，再把**图像本身**作为图像块返回 —— 和 `read_image` 走同一条附件链路，模型能直接看见。

## 能读什么

| 扩展名 | 首选解码 | 兜底 |
|---|---|---|
| `.jxl` | `djxl.exe`（libjxl） | Windows WIC 的「Microsoft JPEG XL Decoder」 |
| `.avif` | `avifdec.exe`（libavif） | WIC 的「Microsoft HEIF Decoder」 |
| `.heic` / `.heif` | WIC 的 HEIF 解码器 | `avifdec.exe`（AVIF-in-HEIF 的情况） |
| `.bmp` / `.tif` / `.tiff` | WIC | — |
| `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` | WIC | — |
| `.psd` | ImageMagick（`magick.exe`） | 未安装则直接报错并给出安装命令 |

两个解码面都只用到机器上已经装好的东西：命令行的 libwebp / libavif / libjxl（默认目录 `C:\dev\tools\codecs`），以及 Windows 自带的 WIC（经 Windows PowerShell 5.1 的 `PresentationCore` 调用，**不是** pwsh 7 —— pwsh 7 没有 WPF 图像程序集）。

## 行为约定

- **只读**：解码器只打开源文件读取，插件写入的全部字节都在缓存目录里。原文件的修改时间、大小、内容都不会变。
- **长边限幅**：`maxWidth` 约束的是**长边**，超过就等比缩小，永不放大。默认 2000，范围 64–8192。
- **缓存**：缓存键 = `规范化路径 + 文件大小 + 修改时间 + 长边上限 + 转换配方版本`，命中后直接复用，不再解码；源文件一改，旧键自然失效。默认在 `%TEMP%\dsh-view-image\`，超过 7 天的条目会被顺手清掉。
- **失败给建议**：缺解码器时说清缺谁、怎么装；格式不支持时列出支持的扩展名；PDF / 视频明确说明属于二期。
- **多帧只取第 1 帧**；不做 EXIF 方向的二次旋转（HEIF/WIC 已处理，JXL/AVIF/TIFF/BMP 基本没有该问题）。
- 不做：PDF 首页、视频抽帧、多图合成。

## 安装 / 验证 / 卸载

### 安装

```
plugin_manager install_bundle
  target: C:\Users\zij10\OneDrive\Documents\deepseek-harness\default-workspace\view-image
```

或者 **插件 → 添加插件 → 选择本地目录**，指到同一个目录。装完在插件页会出现「看图（更多格式）」这一行；新工具 `view_image` 立刻可用，不需要重启。

### 验证

```
view_image({ path: "<某个 .jxl 文件>" })      # 应看到图像
view_image({ path: "<某个 .avif 文件>" })
view_image({ path: "<某个 .bmp 或 .tiff>" })
view_image({ path: "<某个 .psd 文件>" })      # 没装 ImageMagick 时应明确报错，而不是崩溃
```

再调一次同一个文件，输出里的 `via ... (cache hit)` 说明缓存生效。离线自检（不花模型 token）：

```
$env:ELECTRON_RUN_AS_NODE=1
& $env:DSH_NODE_EXECUTABLE <插件目录>\test\convert.test.mjs
```

### 卸载

```
plugin_manager remove_bundle  target: dsh-view-image
```

缓存可以留着（只是占空间）或删掉：

```
Remove-Item -Recurse "$env:TEMP\dsh-view-image"
```

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时整个插件不注册工具 |
| `defaultMaxWidth` | `2000` | 调用方没给 `maxWidth` 时用的长边上限 |
| `codecDir` | `C:\dev\tools\codecs` | 命令行解码器目录；也会去 `PATH` 里找 |
| `cacheDir` | `%TEMP%\dsh-view-image` | 缓存目录 |
| `cacheMaxAgeDays` | `7` | 超过这个天数的缓存条目会被清理 |
| `timeoutMs` | `120000` | 单次外部解码的超时 |
| `maxSourceBytes` | `536870912` | 源文件大小上限，超了先让你降采样 |
| `powershellPath` | 系统 Windows PowerShell 5.1 | 换一个 PowerShell 时用 |

## 边界

- HEIC/HEIF 依赖系统的「HEIF 图像扩展」；没有扩展时 `avifdec` 只能处理 AVIF 容器，纯 HEVC 的 HEIC 会报"缺解码器"。
- JXL 的 WIC 扩展若被卸载，就只剩 `djxl.exe` 一条路。
- Windows PowerShell 5.1 是硬依赖（WPF 图像栈）。精简版系统若移除了它，只能装 ImageMagick 或换回 `read_image` 支持的格式。
