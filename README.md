# 北山新媒体运营工作台

北山新媒体运营工作台支持在 DeepSeek Harness 聊天中查询多平台内容数据、查看单期复盘、登记分发计划，并调用本机麦田发布工作流。

这是 Harness 原生 Cordis bundle。它连接已运行的麦田工作台，不是 DeepSeek 官网聊天页面扩展，也不是 Chrome 发布助手的替代品。

## 安装

需要 Node.js ≥ 24.9、DeepSeek Harness `0.2.2-rc.3`（或本包 `engines.dsh` 支持的后续版本），以及运行中的[麦田](https://github.com/CzzzzzzJ/mdldm-maitian)。真实采集、上传还需要配套[发布助手](https://github.com/CzzzzzzJ/mdldm-maitian-publisher)和专用 Chrome 登录态。

桌面版可在“插件 → 添加插件”中安装本地 tarball 或 Git 版本地址。桌面版使用独立的 `desktop` profile，命令行的 `web` profile 不会改变桌面版。

当前公开安装源是下方的 Git 标签；npm 尚未发布。npm 发布后可使用：

```sh
npx @deepseek-ai/dsh@0.2.2-rc.3 plugin --profile web add dsh-plugin-maitian@0.1.1
```

也可从本仓库的版本标签安装（纯 JS，无本地构建脚本）：

```sh
dsh plugin --profile web add github:songsongs/dsh-plugin-maitian#v0.1.1
```

有本地 tarball 时，也可执行 `dsh plugin --profile web add ./dsh-plugin-maitian-0.1.1.tgz`。本插件没有安装或构建脚本。发布文件中不包含麦田口令、数据库、平台 Cookie、Chrome 用户目录或本地发布工程。

## 连接本机麦田

在 Harness 的插件配置界面中，为 `maitian` 设置 `configFile`（麦田 `config.json` 的绝对路径）和 `maitianDir`（麦田仓库绝对路径）。要启用命令调用，再打开 `enableCommands`。

也可在 profile 的 `cordis.patch.yml` 中添加覆盖：

```yaml
- id: maitian
  config:
    configFile: 'D:/your-project/maitian/config.json'
    maitianDir: 'D:/your-project/maitian'
    enableCommands: true
```

不要把个人配置放进公开仓库。麦田口令会从本地配置读取，不会作为工具参数传给模型，也不会放进访问 URL。

只通过 HTTP 连接时，可设置 `baseUrl`，并设置环境变量 `MAITIAN_WEB_KEY`。远程连接必须显式设置 `allowRemote: true` 并使用 HTTPS；本机命令仍需要本机麦田目录。使用 `baseUrl` 不会自动启动麦田。

## 可以怎么问

- “用北山新媒体运营工作台看看最近五期在各平台的表现。”
- “列出未发布的内容，查看这一期的文案和复盘。”
- “查看小红书近期的粉丝增长。”
- “把这个发布工程登记进麦田计划。”
- “把这期素材填写到 B 站和抖音，发布前我来核对。”

| 工具 | 功能 |
| --- | --- |
| `maitian_overview` | 工作台概况、健康状态、最近五期 |
| `maitian_episodes` | 期数和发布状态，支持筛选、分页 |
| `maitian_episode` | 指定一期的文案、数据、日志和复盘 |
| `maitian_metrics` | 已保存的播放或粉丝历史，不触发采集 |
| `maitian_command` | 可选的本机 CLI 调用，默认不注册 |

`maitian_command` 只接受 `status / plan / run / sync / doctor / followers / metrics / review / weekly / login`。工程必须位于麦田配置的 `rootPath` 子目录中，`run` 必须指定平台。不提供任意 shell、强制重传或 daemon 调用。

`plan/run/sync/doctor/followers/metrics/login` 在执行前请求 Harness 审批；拒绝、取消、无可用审批通道或没有会话时均不执行。`run` 会上传素材，是否自动提交由麦田自身的配置决定；`doctor/metrics` 等命令还可能触发已配置的飞书通知。命令失败或取消时，平台页面可能已完成部分操作，应先查询状态并人工核对，避免重复上传。

## 配置与限制

连接超时默认 15 秒，单次 HTTP 响应上限 8 MiB；大数据量可调整 `maxResponseBytes`。CLI 普通命令默认 5 分钟，上传默认 60 分钟，可通过 `commandTimeoutMs`、`publishTimeoutMs` 调整。`maxCommandOutputBytes` 默认 1 MiB。

支持显式 URL、环境口令和本机配置文件；不上传或托管麦田数据。查询结果会提供给当前 Harness 模型，因此你应使用适合这些内容的模型账号和会话。

已在 Windows 上验证工作台连接、官方工具执行链、卸载清理、原生 bundle 安装及参数/审批边界；真实上传和各平台采集仍需要账号与素材实测。麦田原版的 macOS 自动启动、NAS 挂载和 X 长文专用路径不由此连接器适配。

## 自建插件市场

Harness 的市场采用自定义索引源。启用“自定义插件索引”实验性 bundle 后，在“插件 → 发现”中添加已发布的 HTTPS `index.json` 地址。索引与 npm 包是两个独立的发布步骤。

如果你要把插件加入 [dsh-market 社区市场](https://github.com/dsh-market/dsh-market)，应向 [awesome-dsh-plugin 目录](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)提交收录条目，维护者合并后才会进入公共目录。发布 npm 包或创建自建索引，都不等于已获公共市场收录。

上游麦田和发布助手均由 CzzzzzzJ 创建，采用 MIT 许可证。本包是独立接入插件，不代表 DeepSeek 或麦田上游官方发布。
