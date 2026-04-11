# Claudian (PI Fork)

`Claudian` 是一个 Obsidian 桌面端插件，把 PI agent 直接嵌到知识库侧边栏里。

你的 Vault 会成为 Agent 的工作目录，支持读写文件、搜索、bash、多轮会话、技能触发与上下文引用。

## Fork 来源

- 上游项目: `YishenTu/claudian`
- 上游地址: `https://github.com/YishenTu/claudian`

这个 fork 保留了上游的通用聊天骨架、provider-neutral registry、设置投影和 Obsidian 集成层，但现在只内建 `pi` provider。

## 当前方向

- 移除 Claude/Codex 的内建接入代码与设置入口
- 聚焦 PI bridge、PI runtime、PI history、PI command catalog
- 降低配置门槛，删除 `PI_AGENT_DIR` 和 `PI_SDK_PATH` 的手动输入

## 主要能力

- PI agent 聊天
- 多标签会话与历史会话切换
- Slash 命令、PI skills、`@` 上下文引用
- Inline Edit（文本就地改写，差异预览）
- `/compact` 压缩

## 运行要求

- Obsidian `>= 1.4.5`
- 仅桌面端（macOS / Linux / Windows）
- Node.js
- 全局安装 `@mariozechner/pi-coding-agent`

## 安装

先安装 PI agent：

```bash
npm install -g @mariozechner/pi-coding-agent
```

插件会自动推导：

- PI agent 目录：`~/.pi/agent`
- PI SDK 入口：`$(npm root -g)/@mariozechner/pi-coding-agent/dist/index.js`

不再需要在插件设置里手动填写 `PI_AGENT_DIR` 或 `PI_SDK_PATH`。

## 开发

```bash
npm install
npm run dev
npm run typecheck
npm run test
npm run build
```

## 架构概览

```text
src/
├── core/                 # provider-neutral contracts/runtime/registry
├── providers/
│   └── pi/               # PI provider + bridge client + history adapter
├── features/chat/
├── features/inline-edit/
├── features/settings/
├── shared/
├── utils/
└── style/
```

## 数据与隐私说明

- 会话元数据存储在 Vault 本地
- PI 原生会话记录由 `~/.pi` 下的本地目录维护
- 本 fork 不内置遥测上报逻辑

## 许可证

MIT License，见 `LICENSE`。

## 致谢

- [Obsidian](https://obsidian.md)
- [PI Coding Agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)
- 上游项目 [YishenTu/claudian](https://github.com/YishenTu/claudian)
