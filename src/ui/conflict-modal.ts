import { App, Modal, Setting } from "obsidian";
import type { GitConflictFile } from "../sync";

interface ConflictResolutionModalOptions {
	repositoryName: string;
	conflictFiles: GitConflictFile[];
	onOpenFile: (filePath: string) => Promise<void>;
	onContinue: () => Promise<void>;
}

export class ConflictResolutionModal extends Modal {
	constructor(app: App, private readonly options: ConflictResolutionModalOptions) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("multi-git-conflict-modal");

		contentEl.createEl("h2", { text: "处理上传冲突" });
		contentEl.createEl("p", {
			text: `${this.options.repositoryName} 有文件同时被本地和远端修改。打开文件，保留最终想要的内容，并删除冲突标记。`,
		});

		const listEl = contentEl.createDiv({ cls: "multi-git-conflict-list" });
		for (const file of this.options.conflictFiles) {
			new Setting(listEl)
				.setName(file.path)
				.setDesc(formatConflictLines(file))
				.addButton((button) => button
					.setButtonText("打开")
					.onClick(async () => {
						await this.options.onOpenFile(file.path);
					}));
		}

		new Setting(contentEl)
			.addButton((button) => button
				.setButtonText("稍后处理")
				.onClick(() => {
					this.close();
				}))
			.addButton((button) => button
				.setButtonText("我已处理完成，继续上传")
				.setCta()
				.onClick(async () => {
					await this.options.onContinue();
					this.close();
				}));
	}
}

function formatConflictLines(file: GitConflictFile): string {
	if (file.conflictLines.length === 0) {
		return "没有检测到冲突标记。文件可能已被删除、移动或已经处理。";
	}

	const visibleLines = file.conflictLines.slice(0, 8).map((line) => `第 ${line} 行`);
	const hiddenCount = file.conflictLines.length - visibleLines.length;
	const suffix = hiddenCount > 0 ? `，另有 ${hiddenCount} 处` : "";
	return `冲突标记：${visibleLines.join("、")}${suffix}`;
}
