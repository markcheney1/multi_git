import { App, ButtonComponent, Modal, Setting } from "obsidian";
import { getRepositoryFolderDisplayName, type GitRepositoryConfig } from "../settings";

export interface UploadRepositoryChoice {
	repository: GitRepositoryConfig;
	reason: string;
	hasPendingConflict?: boolean;
}

interface UploadSelectionModalOptions {
	repositories: UploadRepositoryChoice[];
	onResolveConflict: (repositoryId: string) => Promise<void>;
	onPreviewDiff: (repositoryId: string) => Promise<void>;
	onUpload: (repositoryIds: string[]) => Promise<void>;
}

export class UploadSelectionModal extends Modal {
	private selectedRepositoryIds = new Set<string>();
	private uploadButton?: ButtonComponent;

	constructor(app: App, private readonly options: UploadSelectionModalOptions) {
		super(app);
		this.selectedRepositoryIds = new Set(options.repositories.map((item) => item.repository.id));
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("multi-git-upload-modal");

		contentEl.createEl("h2", { text: "选择要上传的仓库" });
		contentEl.createEl("p", {
			text: "以下仓库检测到本地改动、未推送提交或未完成的冲突处理。请选择这次要上传的仓库。",
		});

		const listEl = contentEl.createDiv({ cls: "multi-git-upload-list" });
		for (const item of this.options.repositories) {
			new Setting(listEl)
				.setName(getRepositoryFolderDisplayName(this.app, item.repository))
				.setDesc(`${item.repository.localPath}：${item.reason}`)
				.addToggle((toggle) => toggle
					.setValue(this.selectedRepositoryIds.has(item.repository.id))
					.onChange((value) => {
						if (value) {
							this.selectedRepositoryIds.add(item.repository.id);
						} else {
							this.selectedRepositoryIds.delete(item.repository.id);
						}
						this.updateUploadButton();
					}))
				.addButton((button) => button
					.setButtonText("查看 diff")
					.onClick(async () => {
						await this.options.onPreviewDiff(item.repository.id);
					}))
				.addButton((button) => {
					if (!item.hasPendingConflict) {
						button.buttonEl.hide();
						return;
					}

					button
						.setButtonText("处理冲突")
						.setCta()
						.onClick(async () => {
							this.close();
							await this.options.onResolveConflict(item.repository.id);
						});
				});
		}

		new Setting(contentEl)
			.addButton((button) => button
				.setButtonText("取消")
				.onClick(() => {
					this.close();
				}))
			.addButton((button) => {
				this.uploadButton = button;
				button
					.setButtonText("上传所选仓库")
					.setCta()
					.onClick(async () => {
						const repositoryIds = Array.from(this.selectedRepositoryIds);
						if (repositoryIds.length === 0) {
							return;
						}

						this.close();
						await this.options.onUpload(repositoryIds);
					});
				this.updateUploadButton();
			});
	}

	private updateUploadButton() {
		this.uploadButton?.setDisabled(this.selectedRepositoryIds.size === 0);
	}
}
