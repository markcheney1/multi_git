import { App, Modal, Notice, Setting } from "obsidian";
import type { GitConflictFile, GitConflictResolution } from "../sync";

interface ConflictResolutionModalOptions {
	repositoryName: string;
	operationText: string;
	conflictFiles: GitConflictFile[];
	onOpenFile: (filePath: string) => Promise<boolean>;
	onResolveFile: (filePath: string, resolution: GitConflictResolution) => Promise<GitConflictFile[]>;
	onRefresh: () => Promise<GitConflictFile[]>;
	onContinue: () => Promise<void>;
}

export class ConflictResolutionModal extends Modal {
	private conflictFiles: GitConflictFile[];

	constructor(app: App, private readonly options: ConflictResolutionModalOptions) {
		super(app);
		this.conflictFiles = options.conflictFiles;
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("multi-git-conflict-modal");

		contentEl.createEl("h2", { text: `处理${this.options.operationText}冲突` });
		contentEl.createEl("p", {
			text: `${this.options.repositoryName} 有文件同时被本地和服务器修改。可以直接选择保留哪一侧，也可以打开文件手动编辑。`,
		});

		const listEl = contentEl.createDiv({ cls: "multi-git-conflict-list" });
		for (const file of this.conflictFiles) {
			this.renderConflictFile(listEl, file);
		}

		new Setting(contentEl)
			.addButton((button) => button
				.setButtonText("重新检查")
				.onClick(async () => {
					await this.refreshDetails();
				}))
			.addButton((button) => button
				.setButtonText("稍后处理")
				.onClick(() => {
					this.close();
				}))
			.addButton((button) => button
				.setButtonText(`继续${this.options.operationText}`)
				.setCta()
				.onClick(async () => {
					await this.options.onContinue();
					this.close();
				}));
	}

	private renderConflictFile(containerEl: HTMLElement, file: GitConflictFile) {
		const fileEl = containerEl.createDiv({ cls: "multi-git-conflict-file" });
		const headerEl = fileEl.createDiv({ cls: "multi-git-conflict-file-header" });
		headerEl.createEl("h3", { text: file.path });
		headerEl.createEl("span", {
			text: formatConflictStatus(file),
			cls: file.conflictBlocks.length > 0 ? "multi-git-conflict-status-error" : "multi-git-conflict-status-done",
		});

		if (file.conflictBlocks.length === 0) {
			fileEl.createEl("p", {
				text: "没有检测到标准 Git 冲突块。文件可能已处理完成、被删除或需要手动确认。",
				cls: "multi-git-conflict-file-note",
			});
		} else {
			for (const [index, block] of file.conflictBlocks.entries()) {
				const blockEl = fileEl.createDiv({ cls: "multi-git-conflict-block" });
				blockEl.createEl("div", {
					text: `冲突 ${index + 1}：第 ${block.startLine}-${block.endLine} 行`,
					cls: "multi-git-conflict-block-title",
				});

				const previewEl = blockEl.createDiv({ cls: "multi-git-conflict-preview" });
				createPreviewPane(previewEl, "本地版本", block.localPreview);
				createPreviewPane(previewEl, "服务器版本", block.remotePreview);
			}
		}

		new Setting(fileEl)
			.addButton((button) => button
				.setButtonText("打开手动处理")
				.onClick(async () => {
					const opened = await this.options.onOpenFile(file.path);
					if (opened) {
						this.close();
					}
				}))
			.addButton((button) => button
				.setButtonText("保留本地版本")
				.setDisabled(file.conflictBlocks.length === 0)
				.onClick(async () => {
					await this.resolveFile(file.path, "local");
				}))
			.addButton((button) => button
				.setButtonText("使用服务器版本")
				.setWarning()
				.setDisabled(file.conflictBlocks.length === 0)
				.onClick(async () => {
					await this.resolveFile(file.path, "remote");
				}));
	}

	private async resolveFile(filePath: string, resolution: GitConflictResolution) {
		try {
			this.conflictFiles = await this.options.onResolveFile(filePath, resolution);
			new Notice(resolution === "local" ? "已保留本地版本" : "已使用服务器版本");
			this.render();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`处理冲突失败：${message}`);
		}
	}

	private async refreshDetails() {
		try {
			this.conflictFiles = await this.options.onRefresh();
			this.render();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`重新检查失败：${message}`);
		}
	}
}

function createPreviewPane(containerEl: HTMLElement, title: string, content: string) {
	const paneEl = containerEl.createDiv({ cls: "multi-git-conflict-preview-pane" });
	paneEl.createEl("div", { text: title, cls: "multi-git-conflict-preview-title" });
	paneEl.createEl("pre", { text: content });
}

function formatConflictStatus(file: GitConflictFile): string {
	if (file.conflictBlocks.length > 0) {
		return `${file.conflictBlocks.length} 个冲突块`;
	}

	if (file.conflictLines.length > 0) {
		return `${file.conflictLines.length} 个冲突标记`;
	}

	return "已处理";
}
