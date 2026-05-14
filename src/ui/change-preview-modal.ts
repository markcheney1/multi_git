import { App, Modal, Notice, Setting } from "obsidian";
import type { GitChangedFile, GitChangedFileKind, GitChangedFileResolution } from "../sync";
import { getRepositoryFolderDisplayName, type GitRepositoryConfig } from "../settings";

export interface RepositoryChangePreview {
	repository: GitRepositoryConfig;
	files: GitChangedFile[];
}

interface ChangePreviewModalOptions {
	title: string;
	description: string;
	repositories: RepositoryChangePreview[];
	onOpenFile: (repository: GitRepositoryConfig, filePath: string) => Promise<boolean>;
	onApplyVersion?: (
		repository: GitRepositoryConfig,
		file: GitChangedFile,
		resolution: GitChangedFileResolution,
	) => Promise<RepositoryChangePreview[]>;
	continueButtonText?: string;
	onContinue?: () => Promise<void>;
}

export class ChangePreviewModal extends Modal {
	private repositories: RepositoryChangePreview[];

	constructor(app: App, private readonly options: ChangePreviewModalOptions) {
		super(app);
		this.repositories = options.repositories;
	}

	onOpen(): void {
		this.modalEl.addClass("multi-git-change-preview-modal-container");
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("multi-git-change-preview-modal");

		contentEl.createEl("h2", { text: this.options.title });
		contentEl.createEl("p", { text: this.options.description });

		if (this.repositories.some((preview) => preview.files.length > 0)) {
			const listEl = contentEl.createDiv({ cls: "multi-git-change-preview-list" });
			for (const preview of this.repositories) {
				this.renderRepository(listEl, preview);
			}
		} else {
			contentEl.createEl("p", {
				text: "没有剩余 diff。",
				cls: "multi-git-empty",
			});
		}

		new Setting(contentEl)
			.addButton((button) => button
				.setButtonText("关闭")
				.onClick(() => {
					this.close();
				}));

		if (this.options.onContinue) {
			new Setting(contentEl)
				.addButton((button) => button
					.setButtonText(this.options.continueButtonText ?? "继续")
					.setCta()
					.onClick(async () => {
						this.close();
						await this.options.onContinue?.();
					}));
		}
	}

	private renderRepository(containerEl: HTMLElement, preview: RepositoryChangePreview) {
		const repositoryEl = containerEl.createDiv({ cls: "multi-git-change-preview-repository" });
		repositoryEl.createEl("h3", { text: getRepositoryFolderDisplayName(this.app, preview.repository) });

		for (const group of getChangeGroups(preview.files)) {
			if (group.files.length === 0) {
				continue;
			}

			repositoryEl.createEl("div", { text: group.title, cls: "multi-git-change-preview-group-title" });
			const groupEl = repositoryEl.createDiv({ cls: "multi-git-change-preview-files" });

			for (const file of group.files) {
				const fileEl = groupEl.createDiv({ cls: "multi-git-change-preview-file" });
				const headerEl = fileEl.createDiv({ cls: "multi-git-change-preview-file-header" });
				headerEl.createSpan({ text: group.symbol, cls: `multi-git-change-preview-symbol ${group.className}` });
				const pathEl = headerEl.createEl("button", { text: file.path, cls: "multi-git-change-preview-path" });
				pathEl.type = "button";
				pathEl.addEventListener("click", () => {
					void this.options.onOpenFile(preview.repository, file.path);
				});

				if (file.oldPath) {
					headerEl.createSpan({ text: `原路径：${file.oldPath}`, cls: "multi-git-change-preview-old-path" });
				}

				const actionsEl = headerEl.createDiv({ cls: "multi-git-change-preview-actions" });
				const diffButton = actionsEl.createEl("button", { text: "查看 diff", cls: "multi-git-change-preview-diff-button" });
				diffButton.type = "button";

				const diffEl = fileEl.createEl("pre", {
					text: file.diff,
					cls: "multi-git-change-preview-diff is-hidden",
				});

				if (this.options.onApplyVersion) {
					const versionActionsEl = fileEl.createDiv({ cls: "multi-git-change-preview-version-actions is-hidden" });
					const localButton = versionActionsEl.createEl("button", { text: "保留本地版本" });
					localButton.type = "button";
					localButton.addEventListener("click", () => {
						void this.applyFileVersion(preview.repository, file, "local");
					});

					const remoteButton = versionActionsEl.createEl("button", { text: "使用服务器版本" });
					remoteButton.type = "button";
					remoteButton.addClass("mod-warning");
					remoteButton.addEventListener("click", () => {
						void this.applyFileVersion(preview.repository, file, "remote");
					});

					diffButton.addEventListener("click", () => {
						const isOpen = !versionActionsEl.hasClass("is-hidden");
						versionActionsEl.toggleClass("is-hidden", isOpen);
					});
				}

				diffButton.addEventListener("click", () => {
					const isOpen = !diffEl.hasClass("is-hidden");
					diffEl.toggleClass("is-hidden", isOpen);
					diffButton.textContent = isOpen ? "查看 diff" : "隐藏 diff";
				});
			}
		}
	}

	private async applyFileVersion(
		repository: GitRepositoryConfig,
		file: GitChangedFile,
		resolution: GitChangedFileResolution,
	) {
		if (!this.options.onApplyVersion) {
			return;
		}

		try {
			this.repositories = await this.options.onApplyVersion(repository, file, resolution);
			new Notice(resolution === "local" ? "已保留本地版本" : "已使用服务器版本");
			this.render();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`应用版本失败：${message}`);
		}
	}
}

interface ChangeGroup {
	kind: GitChangedFileKind;
	title: string;
	symbol: string;
	className: string;
	files: GitChangedFile[];
}

function getChangeGroups(files: GitChangedFile[]): ChangeGroup[] {
	return [
		createGroup(files, "conflict", "需要确认", "!", "multi-git-change-preview-conflict"),
		createGroup(files, "added", "新增", "+", "multi-git-change-preview-added"),
		createGroup(files, "modified", "修改", "~", "multi-git-change-preview-modified"),
		createGroup(files, "renamed", "重命名", "R", "multi-git-change-preview-renamed"),
		createGroup(files, "deleted", "删除", "-", "multi-git-change-preview-deleted"),
	];
}

function createGroup(
	files: GitChangedFile[],
	kind: GitChangedFileKind,
	title: string,
	symbol: string,
	className: string,
): ChangeGroup {
	return {
		kind,
		title,
		symbol,
		className,
		files: files.filter((file) => file.kind === kind),
	};
}
