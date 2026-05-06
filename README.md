# Multi Git Sync

Multi Git Sync 是一个 Obsidian 桌面端插件，用于把多个 Git 仓库同步到当前 vault 中的指定目录。

## 功能

- 添加多个 Git 远程链接。
- 为每个仓库指定 vault 内的同步目录。
- 支持 `https://`、`ssh://` 和 `git@host:path` 格式的 SSH Git 地址。
- 支持为仓库指定分支，留空时使用默认分支。
- 支持手动拉取单个仓库或拉取所有已启用仓库。
- 支持手动上传本地改动，插件会自动生成提交并在上传前同步远端更新。
- 上传遇到冲突时，会显示冲突文件和冲突标记行。用户在 Obsidian 中处理后，选择 **继续上传** 即可自动提交并上传。
- 支持为每个仓库单独启用定时拉取。
- 在设置页显示最近一次拉取、上传状态和错误信息。

## 使用方式

1. 在 Obsidian 中启用插件。
2. 打开 **Settings → Community plugins → Multi Git Sync**。
3. 选择 **添加**。
4. 填写 **Git 链接** 和 **Vault 目录**。
5. 按需填写 **分支**，并启用 **定时拉取**。
6. 选择 **拉取最新内容** 下载远端更新。
7. 修改笔记后，选择 **上传本地改动**。插件会自动提交、同步远端并上传。

示例：

```text
Git 链接：https://github.com/user/notes.git
Vault 目录：Git/notes
分支：main
拉取间隔：30
```

带端口的 SSH 地址也可以直接填写：

```text
ssh://git@gitlab.example.com:2222/user/notes.git
```

首次拉取或上传时，如果目标目录不存在或目标目录为空，插件会执行 `git clone`。后续拉取会在对应目录中执行 `git pull --ff-only`。如果配置了分支，插件会先 `fetch` 对应分支，切换到该分支后再执行 fast-forward pull。

上传本地改动时，插件会执行以下固定流程：

```text
检查本地改动
自动提交本地改动
同步远端更新
上传到远端
```

自动提交信息格式类似：

```text
Update from Obsidian 2026-05-06 15:30
```

如果远端和本地修改了同一处内容，上传会暂停。插件会显示冲突文件和冲突标记行。打开文件后，保留最终想要的内容，并删除以 `<<<<<<<`、`=======`、`>>>>>>>` 开头的冲突标记行。

处理完成后选择 **继续上传**，插件会自动提交处理结果并上传。

## 注意事项

- 插件依赖本机 `git` 命令，因此仅支持 Obsidian 桌面端。
- `Vault 目录` 必须是当前 vault 内的相对路径，不能指向 vault 外部。
- 如果 `Vault 目录` 或它的父目录包含符号链接，插件会停止同步，避免写入 vault 外部。
- 如果目标目录已存在、非空且不是 Git 仓库，插件会停止同步，避免覆盖已有内容。
- 如果目标目录已存在且是 Git 仓库，插件会要求它的 `origin` 与配置的 **Git 链接** 完全一致；不一致时会停止同步。
- 如果仓库存在未提交的本地修改，**拉取最新内容** 可能失败。可以改用 **上传本地改动**，插件会先自动提交本地改动，再同步远端。
- 如果上传遇到冲突，插件不会自动丢弃任何一边的内容。请在 Obsidian 中处理冲突文件后选择 **继续上传**。
- SSH 地址需要你提前在本机配置好 SSH key 和远程仓库权限。
- 不建议把访问令牌直接写在 HTTPS URL 中；如果必须使用，请注意 Obsidian 插件配置会保存在本地。

## 通过 BRAT 安装

1. 在 Obsidian 中安装并启用 **BRAT**。
2. 打开 **Settings → Community plugins → BRAT**。
3. 选择 **Add Beta plugin**。
4. 输入仓库地址：

```text
https://github.com/markcheney1/multi_git
```

5. BRAT 会从 GitHub Releases 下载 `main.js`、`manifest.json` 和 `styles.css`。
6. 回到 **Settings → Community plugins**，启用 **Multi Git Sync**。

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

## 发布

GitHub Release 的 tag 必须和 `manifest.json` 中的 `version` 完全一致，不要加 `v` 前缀。

发布 `1.1.0`：

```bash
git tag 1.1.0
git push origin master
git push origin 1.1.0
```

推送 tag 后，GitHub Actions 会自动构建并创建 release，上传以下 BRAT 需要的资产：

- `main.js`
- `manifest.json`
- `styles.css`
