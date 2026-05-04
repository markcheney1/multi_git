# Multi Git Sync

Multi Git Sync 是一个 Obsidian 桌面端插件，用于把多个 Git 仓库同步到当前 vault 中的指定目录。

## 功能

- 添加多个 Git 远程链接。
- 为每个仓库指定 vault 内的同步目录。
- 支持 `https://`、`ssh://` 和 `git@host:path` 格式的 SSH Git 地址。
- 支持为仓库指定分支，留空时使用默认分支。
- 支持手动同步单个仓库或同步所有已启用仓库。
- 支持为每个仓库单独启用定时同步。
- 在设置页显示最近一次同步状态和错误信息。

## 使用方式

1. 在 Obsidian 中启用插件。
2. 打开 **Settings → Community plugins → Multi Git Sync**。
3. 选择 **添加**。
4. 填写 **Git 链接** 和 **Vault 目录**。
5. 按需填写 **分支**，并启用 **定时同步**。
6. 选择 **立即同步**，或使用命令面板里的 **同步所有 Git 仓库**。

示例：

```text
Git 链接：https://github.com/user/notes.git
Vault 目录：Git/notes
分支：main
同步间隔：30
```

首次同步时，如果目标目录不存在或目标目录为空，插件会执行 `git clone`。后续同步会在对应目录中执行 `git pull --ff-only`。如果配置了分支，插件会先 `fetch` 对应分支，切换到该分支后再执行 fast-forward pull。

## 注意事项

- 插件依赖本机 `git` 命令，因此仅支持 Obsidian 桌面端。
- `Vault 目录` 必须是当前 vault 内的相对路径，不能指向 vault 外部。
- 如果 `Vault 目录` 或它的父目录包含符号链接，插件会停止同步，避免写入 vault 外部。
- 如果目标目录已存在、非空且不是 Git 仓库，插件会停止同步，避免覆盖已有内容。
- 如果目标目录已存在且是 Git 仓库，插件会要求它的 `origin` 与配置的 **Git 链接** 完全一致；不一致时会停止同步。
- 如果仓库存在未提交的本地修改，`git pull --ff-only` 可能失败。请先在本机处理 Git 冲突或未提交改动。
- SSH 地址需要你提前在本机配置好 SSH key 和远程仓库权限。
- 不建议把访问令牌直接写在 HTTPS URL 中；如果必须使用，请注意 Obsidian 插件配置会保存在本地。

## 开发

安装依赖：

```bash
npm install
```

开发模式：

```bash
npm run dev
```

生产构建：

```bash
npm run build
```

## 手动安装

构建后，将以下文件复制到 vault 的插件目录：

```text
<Vault>/.obsidian/plugins/multi-git-sync/
```

需要的文件：

- `main.js`
- `manifest.json`
- `styles.css`

然后在 Obsidian 中重新加载并启用插件。
