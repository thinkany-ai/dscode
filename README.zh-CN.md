<p align="center">
  <img src="assets/dscode-logo.svg" width="144" alt="DSCode 方块鲸 Logo">
</p>

# DSCode

<p align="center">
  默认使用 DeepSeek、支持多个模型供应商的本地优先 coding agent。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="LICENSE">MIT License</a> ·
  <a href="docs/COMPARISON.md">产品对比</a>
</p>

DSCode 是一套有明确取舍的 coding-agent runtime：以经济的 DeepSeek V4 Flash 为默认模型，并
内置支持 Codex、OpenAI、Anthropic、OpenRouter、Z.AI、Kimi、MiniMax 和 xAI。它把
provider-aware 路由、本地会话、安全 patch、并行 agent、OS sandbox，以及用量统计组合在一起。

DSCode 不追求在功能数量上超过所有通用 coding agent；目标是保持 runtime 本地、透明，并允许
每个仓库任务选择真正需要的模型能力。

## 为什么选择 DSCode

- **DeepSeek 优先，但不限于 DeepSeek。** DeepSeek V4 Flash 仍是默认模型，继续使用专用 Responses
  adapter、原生 freeform `apply_patch` 和服务端 Web Search；也可以在不改变工具与会话的情况下
  切换到 Codex、OpenAI、Anthropic、OpenRouter、Z.AI、Kimi、MiniMax 或 Grok。
- **模型支持时可识图。** 可在 TUI 粘贴图片或通过 `@file` 传入；GPT-5.6 等模型能检查截图，
  会收到真正的图片 attachment，text-only DeepSeek 模型则会给出明确限制。
- **围绕成本设计。** Runtime 直接利用 DeepSeek 的 1M context 和硬盘前缀缓存；`/status` 会显示
  context、缓存命中、token、reasoning 和预估费用。最新价格以
  [DeepSeek 官方价格页](https://api-docs.deepseek.com/quick_start/pricing/)为准。
- **并行但不失控。** 内置 explorer、implementer、reviewer、tester 四种角色，最多四路并行；
  implementer 在独立 Git worktree 中修改，主 agent 负责集成和最终验证。
- **本地控制。** 会话以树形 JSONL 保存在本地；命令默认在 OS sandbox 中运行并禁止联网；API key
  不传给子进程；每次成功 patch 都生成持久且带冲突保护的 checkpoint。
- **无需重学工作流。** 支持 `AGENTS.md`、`CLAUDE.md`、Agent Skills、MCP、hooks、项目 trust、后台
  任务、JSONL/CI、RPC 和 VS Code 入口。

与 Claude Code、Codex 的事实对比见[产品对比](docs/COMPARISON.md)。简而言之：它们的生态和通用
能力更成熟；DSCode 更小、更偏向 DeepSeek，同时强调本地控制和可审计的 MIT runtime。

## 快速开始

要求 Node.js 22.19+ 和 Git。DSCode 运行时也使用 `rg`；安装器会准备 pnpm，并在 macOS 可用时通过
Homebrew 安装 ripgrep。

从 npm 安装：

```bash
npm install -g @thinkany/dscode
```

也可以安装最新源码版本：

```bash
curl -fsSL https://raw.githubusercontent.com/thinkany-ai/dscode/refs/heads/main/scripts/install.sh | sh
```

确认 `~/.local/bin` 已加入 `PATH`，然后启动 DSCode：

```bash
dscode -C /path/to/project
```

全新安装进入 TUI 后输入 `/login` 选择供应商。认证成功后 DSCode 会选择该 provider 的默认模型；
非交互命令和未显式指定 provider 的配置仍默认使用 DeepSeek。

| 供应商 | ID | 认证方式 |
| --- | --- | --- |
| DeepSeek | `deepseek` | API key |
| OpenAI Codex | `openai-codex` | 符合条件的 ChatGPT 套餐 |
| OpenAI | `openai` | API key |
| Anthropic | `anthropic` | Claude 账号或 API key |
| OpenRouter | `openrouter` | OpenRouter 账号或 API key |
| Z.AI Coding Plan | `zai` | API key |
| Kimi For Coding | `kimi-coding` | Kimi Code 账号或 API key |
| MiniMax | `minimax` | API key |
| xAI / Grok | `xai` | Grok/X 账号或 API key |

`/login` 和 `--provider` 也接受 `kimi`、`grok` 这两个易记别名。

配置 DeepSeek 时，DSCode 会遮罩 API key，然后提供可选的 API base URL；直接回车使用
`https://api.deepseek.com`，也可以填写兼容 DeepSeek/OpenAI 的第三方网关。默认优先把凭证保存到
操作系统钥匙串；无 UI 进程或钥匙串不可用时回退到权限为 `0600` 的 `~/.dscode/auth.json`。
endpoint 保存到权限为 `0600` 的 `~/.dscode/config.json`。
优先级为 `--base-url`、`DEEPSEEK_BASE_URL`、本地保存值、DeepSeek 官方地址。如果不希望保存密钥：

```bash
export DEEPSEEK_API_KEY="sk-..."
export DEEPSEEK_BASE_URL="https://api.deepseek.com"
dscode -C /path/to/project
```

也可以在进入 TUI 前完成认证：

```bash
dscode login deepseek      # DeepSeek API key
dscode login openai-codex  # 浏览器 OAuth，使用 ChatGPT 套餐限额
dscode login openai        # 安全输入 OpenAI API key
dscode login anthropic     # Claude 账号或 Anthropic API key
dscode login openrouter    # OpenRouter 账号或 API key
```

选择的 provider 和模型会保存供后续启动使用，也可以随时覆盖：

```bash
dscode --provider openai-codex --model gpt-5.6-sol -C /path/to/project
dscode --provider deepseek --model deepseek-v4-flash -C /path/to/project
```

DSCode 的全局数据统一保存在 `~/.dscode`：

```text
~/.dscode/settings.json    TUI 与运行时偏好
~/.dscode/config.json      存储策略与 DeepSeek endpoint
~/.dscode/auth.json        仅当前用户可读的凭证回退
~/.dscode/credential-metadata.json  不含密钥的钥匙串索引
~/.dscode/state.sqlite     会话元数据与桌面运行状态
~/.dscode/skills/          全局 skills
~/.dscode/extensions/      全局 extensions
~/.dscode/mcp.json         全局 MCP servers
~/.dscode/hooks.json       全局 hooks
~/.dscode/sessions/YYYY/MM/DD/  JSONL 会话正文
~/.dscode/archived_sessions/   已归档会话
```

顶层的 `sessions/*.jsonl` 是为当前终端运行时保留的硬链接兼容入口，与日期目录中的正文指向
同一个 inode，不会重复占用空间。JSONL 是会话正文的唯一事实来源；SQLite 只保存可搜索的
会话元数据、置顶/归档状态和文件指纹。

可以在 `~/.dscode/config.json` 中配置凭证与历史记录策略：

```json
{
  "cli_auth_credentials_store": "auto",
  "history": { "persistence": "save-all" }
}
```

凭证模式支持 `auto`、`keyring`、`file`。把历史策略设为 `none` 后，新会话不会写入正文。
`DSCODE_SQLITE_HOME` 可单独迁移 SQLite 状态目录。

可用 `DSCODE_HOME` 修改整个目录，用 `DSCODE_SESSIONS_DIR` 单独修改会话目录。DSCode 不再继承
`PI_CODING_AGENT_DIR`。首次启动会把旧的 `~/.dscode/agent` 内容无损复制到新目录，不删除、
不覆盖已有文件。项目 skills 建议使用可移植的 `.agents/skills/` 约定。

## 默认配置

全新安装使用：

```text
model       deepseek-v4-flash
transport   responses
thinking    max
harness     minimal
permission  auto
sandbox     workspace-write
network     blocked
```

默认 `minimal` harness 只暴露少量高杠杆工具：沙箱命令、后台进程交互、freeform patch 和并行
delegation。`--harness safe` 会额外提供显式文件读取、文件搜索和自动语言诊断。

## 常用启动方式

```bash
# 新会话
dscode -C ./my-project

# 继续或选择历史会话
dscode -C ./my-project --continue
dscode -C ./my-project --resume

# 一次性输出、JSONL 自动化或 IDE RPC
dscode -C ./my-project -p "解释认证流程"
dscode -C ./my-project --mode json -p "修复 lint 并运行测试"
dscode -C ./my-project --mode rpc

# 使用支持视觉的模型检查截图
dscode --provider openai-codex @screenshot.png "解释这个错误"
```

在 TUI 中粘贴 PNG、JPEG、GIF 或 WebP 图片并输入问题即可。DSCode 会立即把终端插入的本地路径
替换为 `[Image #N]`，并把图片数据作为 attachment 随消息发送；每轮最多支持 8 张图片，每张最大
20 MB。

TUI 常用命令：

| 命令 | 作用 |
| --- | --- |
| `/plan` | 进入或退出结构化只读规划 |
| `/permissions` | 查看或切换 `plan`、`ask`、`auto`、`full` 权限 |
| `/status` | 查看模型、context、缓存命中、token、费用和会话信息 |
| `/diff` | 查看当前 patch transcript |
| `/checkpoints` / `/undo` | 查看或恢复持久 checkpoint |
| `/new` / `/clear` | 清除当前 context 并开始一个新会话（两者等价） |
| `/resume` / `/fork` / `/tree` | 导航树形本地会话 |
| `/compact` | 压缩旧 context，同时保留当前工作状态 |
| `/jobs` | 查看可重连的后台命令 |
| `/mcp` / `/agents` / `/doctor` | 查看集成、agent 和运行状态 |
| `/login [provider]` | 选择并认证支持的模型供应商 |
| `/model` | 选择已配置的模型，并保存选择 |
| `/effort ...` | 调整当前模型的 reasoning effort |

输入 `/` 查看全部命令，输入 `/hotkeys` 查看快捷键。

## 安全模型

权限决定 DSCode 什么时候询问；sandbox 决定命令实际上能访问什么。

| 模式 | 行为 |
| --- | --- |
| `plan` | 只读调查；隐藏写入、delegate 和 MCP 工具 |
| `ask` | 命令、写入、delegate 和 MCP 都需要批准 |
| `auto` | 普通工作区操作自动执行；破坏性命令、联网、宿主机访问和外部 MCP 仍受控 |
| `full` | 可信模式，命令拥有不受限的宿主机文件系统和网络访问 |

默认命令边界是 `workspace-write` 且禁止联网。命令需要联网或宿主机访问时，TUI 会提供
**仅本次允许 / 本次会话始终允许这条命令 / 拒绝**，然后用最小必要权限自动重试。`--network`
可以为本次运行预授权网络；`--permission full` 只应用于完全可信的工作区。`dscode -y` 是明确的
YOLO 快捷方式：本次运行直接信任项目资源、跳过工具审批、关闭 sandbox 并开放网络。

macOS 使用 Seatbelt；Linux 和 Windows 使用配置好的 Docker sandbox：

```bash
export DSCODE_SANDBOX_IMAGE="your-reviewed-image:tag"
dscode -C ./project --sandbox workspace-write
```

没有可用 sandbox 后端时，DSCode 会 fail closed，不会悄悄在宿主机运行。

## DeepSeek 专用适配

- Responses API 无状态；DSCode 从本地会话树回放消息、reasoning item 和工具结果。
- Adapter 会删除 DeepSeek 不支持的 OpenAI store、cache retention 和 include 字段。
- Thinking 模式会删除 DeepSeek 忽略的采样参数，并支持 `low`、`high`、`max` effort。
- `apply_patch` 使用原生 freeform custom tool，避免大 diff 的 JSON 转义。
- Prompt 和工具顺序保持稳定，为 DeepSeek 自动前缀缓存保留可复用前缀。
- `--web` 加入 DeepSeek 服务端 Web Search，不代替本地仓库搜索。

这些转换只在当前 provider 为 `deepseek` 时执行；其他供应商使用运行时内置的原生实现。
Provider API key 不会传给命令、hooks 或 stdio MCP server。

## 扩展与自动化

- 分层读取 `AGENTS.md` 和 `CLAUDE.md`
- 用户级和项目级 Agent Skills
- 可信项目 hooks 与 MCP server
- 可重连后台命令
- 面向 CI 的 JSONL，以及完整 stdin/stdout RPC 模式
- 可复用的 `@thinkany/dscode-core` 包及其内置 headless RPC worker
- [editors/vscode](editors/vscode/README.md) 中的 VS Code 扩展
- `safe` harness 自动发现 TypeScript、Pyright、Rust、Go 和 Swift diagnostics

图形客户端和 IDE 集成可以直接安装 `@thinkany/dscode-core`，不要求用户全局安装 CLI。Core
提供凭证、设置 API 和类型化 RPC client，使用与终端版完全相同的 Agent、工具、权限和本地会话格式：

```ts
import { createDSCodeRpcClient } from "@thinkany/dscode-core/rpc";

const client = createDSCodeRpcClient({ cwd: "/path/to/project" });
await client.start();
client.onEvent((event) => render(event));
await client.prompt("检查这个仓库");
```

普通 `@thinkany/dscode` tarball 会内嵌相同版本的 Core 构建，因此现有 CLI 安装不会新增运行时
registry 依赖，也不会改变命令、配置或会话行为。

## 从源码构建

```bash
git clone https://github.com/thinkany-ai/dscode.git
cd dscode
corepack enable
pnpm install
pnpm check
pnpm dev -C /path/to/project
```

常用验证命令：

```bash
pnpm check             # 类型检查、测试和生产构建
pnpm smoke:live        # 使用真实 DeepSeek API 的修改与测试 smoke flow
pnpm acceptance:live   # 完整真实 API 功能验收
```

日常开发提交到 `dev`；带新版本号的提交合并到 `main` 并通过 CI 后，会自动创建对应的 GitHub
Release 并发布 npm 包。详细流程见 [Releasing DSCode](docs/RELEASING.md)。

## 当前边界

- DeepSeek V4 Flash 仍只接受文本输入；截图等图片任务需要切换到支持视觉的模型。
- ChatGPT 套餐登录受账号可用模型、用量限制和 workspace 权限约束；OpenAI API key 的用量由 API
  平台单独计费。
- VS Code 扩展是本地集成，尚未发布到 Marketplace。
- Linux 和 Windows 的隔离能力取决于配置的 Docker 镜像。
- DSCode 仍是早期项目；Claude Code 和 Codex 当前拥有更广泛的 IDE、云端、多模态和生态支持。

我们不认为功能清单能够证明 DSCode 全面更好。项目应在真实仓库任务上按成功率、耗时、成本、
安全和人工接管率进行评测。

## License

[MIT](LICENSE)
