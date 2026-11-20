# dsh-view-image

让 agent 看见 `read_image` 读不了的图片：JXL、AVIF、HEIC/HEIF、BMP、TIFF（PSD 需要 ImageMagick）。

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的插件。内置的 `read_image` 只认 PNG / JPEG / WebP / GIF；这个插件新增工具 `view_image`：先把文件转成 PNG，再把**图像本身**作为图像块返回 —— 和 `read_image` 走同一条附件链路，模型能直接看见。

## 它解决什么

| 格式 | `read_image` | `view_image` |
|---|:---:|:---:|
| PNG / JPEG / WebP / GIF | ✅ | ✅（顺带给到 `maxWidth`） |
| JXL / AVIF | ❌ | ✅ |
| HEIC / HEIF | ❌ | ✅（依赖系统 HEIF 扩展） |
| BMP / TIFF | ❌ | ✅ |
| PSD | ❌ | 需要 ImageMagick |
| PDF / 视频 | ❌ | 二期，明确报错 |

## 怎么解码

| 扩展名 | 首选 | 兜底 |
|---|---|---|
| `.jxl` | `djxl.exe`（libjxl） | WIC「Microsoft JPEG XL Decoder」 |
| `.avif` | `avifdec.exe`（libavif） | WIC「Microsoft HEIF Decoder」 |
| `.heic` / `.heif` | WIC HEIF 解码器 | `avifdec.exe` |
| `.bmp` / `.tif` / `.tiff` / `.png` / `.jpg` / `.gif` / `.webp` | WIC | — |
| `.psd` | `magick.exe` | 没有就报错并给安装命令 |

两个解码面都只用机器上已经存在的东西：命令行编解码器（默认目录 `C:\dev\tools\codecs`，也会在 `PATH` 里找），和 Windows 自带的 WIC —— 经 **Windows PowerShell 5.1** 的 `PresentationCore` 调用，不是 pwsh 7（pwsh 7 没有 WPF 图像程序集）。

## 安装

```bash
dsh plugin --profile <profile> add <this-repo>
```

或在 DSH 里用插件管理器，`target` 传绝对目录 / git 地址：

```
plugin_manager { action: "install_bundle", target: "C:\\path\\to\\view-image" }
```

装完插件页会出现「看图（更多格式）」，新工具 `view_image` 立刻可用（不必重启）。

## 使用

```
view_image({ path: "C:\\shots\\a.jxl" })
view_image({ path: "C:\\shots\\b.avif", maxWidth: 4000 })   # 小字多的截图想保细节
view_image({ path: "view-image/docs/DETAIL.md" })            # 相对路径按会话工作目录解析
```

参数只有两个：

- `path`：图片路径，相对路径按**会话工作目录**解析。
- `maxWidth`：长边像素上限，默认 2000，范围 64–8192，只缩小不放大。

## 配置

`cordis.patch.yml` 的行配置：

```yaml
- insert:
    - id: view-image
      name: dsh-view-image
      config:
        enabled: true
        defaultMaxWidth: 2000
        codecDir: 'C:\dev\tools\codecs'
        cacheMaxAgeDays: 7
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时整个插件不注册工具 |
| `defaultMaxWidth` | `2000` | 调用方没给 `maxWidth` 时的长边上限 |
| `codecDir` | `C:\dev\tools\codecs` | 命令行解码器目录，也会查 `PATH` |
| `cacheDir` | `%TEMP%\dsh-view-image` | 缓存目录 |
| `cacheMaxAgeDays` | `7` | 超期缓存条目会被清理 |
| `timeoutMs` | `120000` | 单次外部解码超时 |
| `maxSourceBytes` | `536870912` | 源文件大小上限 |
| `powershellPath` | 系统 Windows PowerShell 5.1 | 换 PowerShell 时用 |

## 三条保证

1. **只读**：解码器只打开源文件读取，插件写入的全部字节都在缓存目录；源文件的 mtime / 大小 / 内容不变。
2. **限幅**：长边超过 `maxWidth` 就等比缩小，**永不放大**，避免一张图吃掉几千 token。
3. **缓存**：键 = 规范化路径 + 大小 + 修改时间 + 长边上限 + 配方版本。源文件一改，旧键自然失效；同一文件重复读不再解码。

## 已知限制

- **HEIC / HEIF 解码路径未在真实文件上验证**：本机没有任何 heic 样本，实现按系统 HEIF 解码器写，代码路径正确但没有真实文件跑过。
- **PSD 成功路径未验证**：本机没装 ImageMagick，只验证了「缺解码器时报清楚错」这条路径。
- 仅 Windows：WIC 走 Windows PowerShell 5.1 的 `PresentationCore`；精简版系统若移除了它，只剩命令行解码器能用。
- 动图 / 多帧只取第 1 帧；不做 EXIF 方向的二次旋转（HEIF/WIC 已处理）。
- PDF 首页、视频抽帧属于二期。
- 源文件超过 `maxSourceBytes` 直接拒绝，先降采样再读。

## 开发

不经过 DSH、不花模型 token 的离线自检：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& $env:DSH_NODE_EXECUTABLE test/convert.test.mjs
```

夹具自己造（WIC 画一张 320×200 的图，编码成 PNG/BMP/TIFF，再写一个假 PSD）：

```powershell
powershell -File test/make-fixtures.ps1 -Out "$env:TEMP\view-image-fixtures"
$env:VIEW_IMAGE_FIXTURES = "$env:TEMP\view-image-fixtures"
& $env:DSH_NODE_EXECUTABLE test/convert.test.mjs
```

JXL / AVIF 那两组用例需要真实样本（不进仓库）。有样本时指过去，没有就自动 SKIP：

```powershell
$env:VIEW_IMAGE_JXL = 'C:\path\to\dir\with\jxl-d3.jxl-and-avif-q63.avif'
```

CI 见 [.github/workflows/ci.yml](.github/workflows/ci.yml)：Ubuntu 只跑静态用例（格式判定 / 缓存键 / 错误分类，`VIEW_IMAGE_STATIC=1`），Windows 跑真实转换（WIC 路径）。JXL / AVIF 的 CI 覆盖需要本机编解码器，缺了就自动 SKIP。

## 许可

MPL-2.0，见 [LICENSE](LICENSE)。本项目的 AI 参与情况见 [AI-DISCLOSURE.md](AI-DISCLOSURE.md)。
