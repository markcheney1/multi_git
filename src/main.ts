import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import { SyncFolderBadgeManager } from "./folder-badges";
import { GitSyncService, type GitConflictFile, type GitConflictResolution } from "./sync";
import {
	GitConflictOperation,
	MultiGitSettingTab,
	MultiGitSettings,
	getRepositoryFolderDisplayName,
	normalizeSettings,
} from "./settings";
import { ChangePreviewModal } from "./ui/change-preview-modal";
import { ConflictResolutionModal } from "./ui/conflict-modal";
import { UploadRepositoryChoice, UploadSelectionModal } from "./ui/upload-selection-modal";

export default class MultiGitPlugin extends Plugin {
	settings: MultiGitSettings;

	private gitSyncService: GitSyncService;
	private folderBadgeManager: SyncFolderBadgeManager;
	private syncTimers: number[] = [];
	private syncingRepositoryIds = new Set<string>();
	private statusBarItemEl: HTMLElement;

	async onload() {
		await this.loadSettings();

		this.gitSyncService = new GitSyncService(this.app);
		this.folderBadgeManager = new SyncFolderBadgeManager(
			this.app,
			() => this.getSyncFolderPaths(),
			() => this.settings.folderBadgeText,
		);
		this.folderBadgeManager.start();

		this.addRibbonIcon("refresh-cw", "拉取 Git 仓库最新内容", () => {
			void this.syncAllRepositories();
		});

		this.addRibbonIcon("upload-cloud", "上传 Git 仓库改动", () => {
			void this.uploadAllRepositories();
		});

		this.statusBarItemEl = this.addStatusBarItem();
		this.updateStatusBar();

		this.addCommand({
			id: "sync-all-repositories",
			name: "拉取所有 Git 仓库最新内容",
			callback: () => {
				void this.syncAllRepositories();
			},
		});

		this.addCommand({
			id: "upload-all-repositories",
			name: "上传所有 Git 仓库改动",
			callback: () => {
				void this.uploadAllRepositories();
			},
		});

		this.register(() => this.clearAutoSyncTimers());
		this.register(() => this.folderBadgeManager.stop());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.folderBadgeManager.refresh()));
		this.registerEvent(this.app.vault.on("create", () => this.folderBadgeManager.refresh()));
		this.registerEvent(this.app.vault.on("delete", () => this.folderBadgeManager.refresh()));
		this.registerEvent(this.app.vault.on("rename", () => this.folderBadgeManager.refresh()));
		this.addSettingTab(new MultiGitSettingTab(this.app, this));
		this.scheduleAutoSync();
	}

	async loadSettings() {
		this.settings = normalizeSettings(await this.loadData() as Partial<MultiGitSettings> | null);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.folderBadgeManager?.refresh();
	}

	async saveSettingsAndReschedule() {
		await this.saveSettings();
		this.scheduleAutoSync();
		this.updateStatusBar();
	}

	async syncAllRepositories(showNotice = true) {
		const repositories = this.settings.repositories.filter((repository) => repository.enabled);

		if (repositories.length === 0) {
			if (showNotice) {
				new Notice("没有已启用的 Git 仓库");
			}
			return;
		}

		this.updateStatusBar("拉取中...");

		let successCount = 0;
		let failedCount = 0;
		let openedConflictModal = false;

		for (const repository of repositories) {
			const success = await this.syncRepository(repository.id, false);
			if (success) {
				successCount += 1;
			} else {
				failedCount += 1;
				if (showNotice && !openedConflictModal && repository.pendingConflict?.operation === "sync") {
					openedConflictModal = true;
					await this.showConflictResolution(repository.id);
				}
			}
		}

		this.updateStatusBar();

		if (showNotice) {
			new Notice(`Git 拉取完成：${successCount} 成功，${failedCount} 失败`);
		}
	}

	async syncRepository(repositoryId: string, showNotice = true): Promise<boolean> {
		const repository = this.settings.repositories.find((item) => item.id === repositoryId);

		if (!repository) {
			if (showNotice) {
				new Notice("未找到 Git 仓库配置");
			}
			return false;
		}

		if (!repository.enabled) {
			if (showNotice) {
				new Notice(`${getRepositoryFolderDisplayName(this.app, repository)} 已停用`);
			}
			return false;
		}

		if (this.syncingRepositoryIds.has(repository.id)) {
			if (showNotice) {
				new Notice(`${getRepositoryFolderDisplayName(this.app, repository)} 正在处理`);
			}
			return false;
		}

		if (repository.pendingConflict) {
			if (showNotice) {
				const operationText = getConflictOperationText(repository.pendingConflict.operation);
				new Notice(`${getRepositoryFolderDisplayName(this.app, repository)} 有未完成的${operationText}冲突，请处理后继续${operationText}`);
				await this.showConflictResolution(repository.id);
			}
			return false;
		}

		this.syncingRepositoryIds.add(repository.id);
		this.updateStatusBar("拉取中...");

		try {
			const result = await this.gitSyncService.sync(repository);
			const now = new Date().toISOString();
			repository.lastSyncedAt = now;
			repository.lastSyncMessage = result.message;

			if (result.conflict) {
				repository.pendingConflict = {
					branch: result.conflict.branch,
					files: result.conflict.files,
					startedAt: now,
					operation: "sync",
				};
				repository.lastSyncStatus = "error";
				await this.saveSettings();

				if (showNotice) {
					new Notice(`${getRepositoryFolderDisplayName(this.app, repository)} 拉取暂停：发现 ${result.conflict.files.length} 个冲突文件`);
					this.openConflictModal(repository.id, result.conflict.details, "sync");
				}

				return false;
			}

			repository.lastSyncedAt = now;
			repository.lastSyncStatus = "success";
			delete repository.pendingConflict;
			await this.saveSettings();

			if (showNotice) {
				new Notice(`${getRepositoryFolderDisplayName(this.app, repository)}：${result.message}`);
			}
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			repository.lastSyncedAt = new Date().toISOString();
			repository.lastSyncStatus = "error";
			repository.lastSyncMessage = message;
			await this.saveSettings();

			if (showNotice) {
				new Notice(`${getRepositoryFolderDisplayName(this.app, repository)} 拉取失败：${message}`);
			}
			return false;
		} finally {
			this.syncingRepositoryIds.delete(repository.id);
			this.updateStatusBar();
		}
	}

	async uploadAllRepositories(showNotice = true) {
		const repositories = this.settings.repositories.filter((repository) => repository.enabled);

		if (repositories.length === 0) {
			if (showNotice) {
				new Notice("没有已启用的 Git 仓库");
			}
			return;
		}

		this.updateStatusBar("检查上传...");

		try {
			const uploadChoices = await this.getUploadRepositoryChoices(repositories);
			if (uploadChoices.length === 0) {
				if (showNotice) {
					new Notice("没有需要上传的仓库");
				}
				return;
			}

			if (!showNotice) {
				await this.uploadRepositories(uploadChoices.map((item) => item.repository.id), false);
				return;
			}

			new UploadSelectionModal(this.app, {
				repositories: uploadChoices,
				onResolveConflict: async (repositoryId) => {
					await this.showConflictResolution(repositoryId);
				},
				onPreviewDiff: async (repositoryId) => {
					await this.showRepositoryDiff(repositoryId);
				},
				onUpload: async (repositoryIds) => {
					await this.uploadRepositories(repositoryIds, true);
				},
			}).open();
		} finally {
			this.updateStatusBar();
		}
	}

	private async uploadRepositories(repositoryIds: string[], showNotice = true) {
		if (repositoryIds.length === 0) {
			if (showNotice) {
				new Notice("没有选择要上传的仓库");
			}
			return;
		}

		this.updateStatusBar("上传中...");

		let successCount = 0;
		let failedCount = 0;
		let conflictCount = 0;
		let openedConflictModal = false;

		for (const repositoryId of repositoryIds) {
			const repository = this.settings.repositories.find((item) => item.id === repositoryId);
			if (repository?.pendingConflict) {
				conflictCount += 1;
				failedCount += 1;
				if (showNotice && !openedConflictModal) {
					openedConflictModal = true;
					await this.showConflictResolution(repository.id);
				}
				continue;
			}

			const success = await this.uploadRepository(repositoryId, false);
			if (success) {
				successCount += 1;
			} else {
				failedCount += 1;
				const updatedRepository = this.settings.repositories.find((item) => item.id === repositoryId);
				if (showNotice && !openedConflictModal && updatedRepository?.pendingConflict) {
					openedConflictModal = true;
					await this.showConflictResolution(updatedRepository.id);
				}
			}
		}

		this.updateStatusBar();

		if (showNotice) {
			const conflictText = conflictCount > 0 ? `，${conflictCount} 个需处理冲突` : "";
			new Notice(`Git 上传完成：${successCount} 成功，${failedCount} 失败或暂停${conflictText}`);
		}
	}

	private async getUploadRepositoryChoices(repositories: MultiGitSettings["repositories"]): Promise<UploadRepositoryChoice[]> {
		const choices: UploadRepositoryChoice[] = [];
		let failedCount = 0;

		for (const repository of repositories) {
			if (this.syncingRepositoryIds.has(repository.id)) {
				failedCount += 1;
				continue;
			}

			if (repository.pendingConflict) {
				const operationText = getConflictOperationText(repository.pendingConflict.operation);
				choices.push({
					repository,
					reason: `有 ${repository.pendingConflict.files.length} 个冲突文件需要处理后继续${operationText}`,
					hasPendingConflict: true,
				});
				continue;
			}

			try {
				const status = await this.gitSyncService.getUploadStatus(repository);
				if (status.needsUpload) {
					choices.push({
						repository,
						reason: status.reason,
					});
				}
			} catch {
				failedCount += 1;
			}
		}

		if (failedCount > 0) {
			new Notice(`有 ${failedCount} 个仓库无法检查上传状态，请确认配置和本地目录`);
		}

		return choices;
	}

	async showRepositoryDiff(repositoryId: string): Promise<void> {
		const repository = this.settings.repositories.find((item) => item.id === repositoryId);

		if (!repository) {
			new Notice("未找到 Git 仓库配置");
			return;
		}

		if (this.syncingRepositoryIds.has(repository.id)) {
			new Notice(`${getRepositoryFolderDisplayName(this.app, repository)} 正在处理`);
			return;
		}

		try {
			const changedFiles = await this.gitSyncService.getChangedFiles(repository);
			const repositoryName = getRepositoryFolderDisplayName(this.app, repository);

			if (changedFiles.length === 0) {
				new Notice(`${repositoryName} 没有可查看的本地 diff`);
				return;
			}

			new ChangePreviewModal(this.app, {
				title: `${repositoryName} 的本地 diff`,
				description: "这些是当前本地分支和未提交内容相对服务器版本的变更。上传前会先同步服务器更新。",
				repositories: [{ repository, files: changedFiles }],
				onOpenFile: async (targetRepository, filePath) => this.openRepositoryFile(targetRepository.localPath, filePath),
				onApplyVersion: async (targetRepository, file, resolution) => {
					if (this.syncingRepositoryIds.has(targetRepository.id)) {
						throw new Error(`${getRepositoryFolderDisplayName(this.app, targetRepository)} 正在处理`);
					}

					const files = await this.gitSyncService.applyChangedFileVersion(targetRepository, file, resolution);
					return [{ repository: targetRepository, files }];
				},
			}).open();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`无法查看 diff：${message}`);
		}
	}

	async uploadRepository(repositoryId: string, showNotice = true): Promise<boolean> {
		const repository = this.settings.repositories.find((item) => item.id === repositoryId);

		if (!repository) {
			if (showNotice) {
				new Notice("未找到 Git 仓库配置");
			}
			return false;
		}

		const repositoryName = getRepositoryFolderDisplayName(this.app, repository);

		if (!repository.enabled) {
			if (showNotice) {
				new Notice(`${repositoryName} 已停用`);
			}
			return false;
		}

		if (this.syncingRepositoryIds.has(repository.id)) {
			if (showNotice) {
				new Notice(`${repositoryName} 正在处理`);
			}
			return false;
		}

		if (repository.pendingConflict) {
			if (showNotice) {
				const operationText = getConflictOperationText(repository.pendingConflict.operation);
				new Notice(`${repositoryName} 有未完成的${operationText}冲突，请处理后继续${operationText}`);
				await this.showConflictResolution(repository.id);
			}
			return false;
		}

		this.syncingRepositoryIds.add(repository.id);
		this.updateStatusBar("上传中...");

		try {
			const result = await this.gitSyncService.upload(repository);
			const now = new Date().toISOString();
			repository.lastUploadedAt = now;
			repository.lastUploadMessage = result.message;

			if (result.conflict) {
				repository.pendingConflict = {
					branch: result.conflict.branch,
					files: result.conflict.files,
					startedAt: now,
					operation: "upload",
				};
				repository.lastUploadStatus = "error";
				await this.saveSettings();

				if (showNotice) {
					new Notice(`${repositoryName} 上传暂停：发现 ${result.conflict.files.length} 个冲突文件`);
					this.openConflictModal(repository.id, result.conflict.details, "upload");
				}

				return false;
			}

			delete repository.pendingConflict;
			repository.lastUploadStatus = "success";
			await this.saveSettings();

			if (showNotice) {
				new Notice(`${repositoryName}：${result.message}`);
			}
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			repository.lastUploadedAt = new Date().toISOString();
			repository.lastUploadStatus = "error";
			repository.lastUploadMessage = message;
			await this.saveSettings();

			if (showNotice) {
				new Notice(`${repositoryName} 上传失败：${message}`);
			}
			return false;
		} finally {
			this.syncingRepositoryIds.delete(repository.id);
			this.updateStatusBar();
		}
	}

	async continueUploadRepository(repositoryId: string, showNotice = true): Promise<boolean> {
		const repository = this.settings.repositories.find((item) => item.id === repositoryId);

		if (!repository) {
			if (showNotice) {
				new Notice("未找到 Git 仓库配置");
			}
			return false;
		}

		const repositoryName = getRepositoryFolderDisplayName(this.app, repository);

		if (!repository.pendingConflict) {
			if (showNotice) {
				new Notice(`${repositoryName} 没有未完成的上传冲突`);
			}
			return false;
		}

		if (repository.pendingConflict.operation === "sync") {
			return this.continueSyncRepository(repositoryId, showNotice);
		}

		if (this.syncingRepositoryIds.has(repository.id)) {
			if (showNotice) {
				new Notice(`${repositoryName} 正在处理`);
			}
			return false;
		}

		this.syncingRepositoryIds.add(repository.id);
		this.updateStatusBar("继续上传...");

		try {
			const previousConflict = repository.pendingConflict;
			const result = await this.gitSyncService.continueUpload(repository, previousConflict);
			const now = new Date().toISOString();
			repository.lastUploadedAt = now;
			repository.lastUploadMessage = result.message;

			if (result.conflict) {
				repository.pendingConflict = {
					branch: result.conflict.branch,
					files: result.conflict.files,
					startedAt: previousConflict.startedAt,
					operation: "upload",
				};
				repository.lastUploadStatus = "error";
				await this.saveSettings();

				if (showNotice) {
					new Notice(`${repositoryName} 仍有冲突需要处理`);
					this.openConflictModal(repository.id, result.conflict.details, "upload");
				}
				return false;
			}

			delete repository.pendingConflict;
			repository.lastUploadStatus = "success";
			await this.saveSettings();

			if (showNotice) {
				new Notice(`${repositoryName}：${result.message}`);
			}
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			repository.lastUploadedAt = new Date().toISOString();
			repository.lastUploadStatus = "error";
			repository.lastUploadMessage = message;
			await this.saveSettings();

			if (showNotice) {
				new Notice(`${repositoryName} 继续上传失败：${message}`);
			}
			return false;
		} finally {
			this.syncingRepositoryIds.delete(repository.id);
			this.updateStatusBar();
		}
	}

	async continueSyncRepository(repositoryId: string, showNotice = true): Promise<boolean> {
		const repository = this.settings.repositories.find((item) => item.id === repositoryId);

		if (!repository) {
			if (showNotice) {
				new Notice("未找到 Git 仓库配置");
			}
			return false;
		}

		const repositoryName = getRepositoryFolderDisplayName(this.app, repository);

		if (!repository.pendingConflict) {
			if (showNotice) {
				new Notice(`${repositoryName} 没有未完成的拉取冲突`);
			}
			return false;
		}

		if (this.syncingRepositoryIds.has(repository.id)) {
			if (showNotice) {
				new Notice(`${repositoryName} 正在处理`);
			}
			return false;
		}

		this.syncingRepositoryIds.add(repository.id);
		this.updateStatusBar("继续拉取...");

		try {
			const previousConflict = repository.pendingConflict;
			const result = await this.gitSyncService.continueSync(repository, previousConflict);
			const now = new Date().toISOString();
			repository.lastSyncedAt = now;
			repository.lastSyncMessage = result.message;

			if (result.conflict) {
				repository.pendingConflict = {
					branch: result.conflict.branch,
					files: result.conflict.files,
					startedAt: previousConflict.startedAt,
					operation: "sync",
				};
				repository.lastSyncStatus = "error";
				await this.saveSettings();

				if (showNotice) {
					new Notice(`${repositoryName} 仍有冲突需要处理`);
					this.openConflictModal(repository.id, result.conflict.details, "sync");
				}
				return false;
			}

			delete repository.pendingConflict;
			repository.lastSyncStatus = "success";
			await this.saveSettings();

			if (showNotice) {
				new Notice(`${repositoryName}：${result.message}`);
			}
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			repository.lastSyncedAt = new Date().toISOString();
			repository.lastSyncStatus = "error";
			repository.lastSyncMessage = message;
			await this.saveSettings();

			if (showNotice) {
				new Notice(`${repositoryName} 继续拉取失败：${message}`);
			}
			return false;
		} finally {
			this.syncingRepositoryIds.delete(repository.id);
			this.updateStatusBar();
		}
	}

	async continueConflictRepository(repositoryId: string, showNotice = true): Promise<boolean> {
		const repository = this.settings.repositories.find((item) => item.id === repositoryId);
		if (!repository?.pendingConflict) {
			if (showNotice) {
				new Notice("没有未完成的冲突");
			}
			return false;
		}

		if (repository.pendingConflict.operation === "sync") {
			return this.continueSyncRepository(repositoryId, showNotice);
		}

		return this.continueUploadRepository(repositoryId, showNotice);
	}

	async showConflictResolution(repositoryId: string): Promise<void> {
		const repository = this.settings.repositories.find((item) => item.id === repositoryId);

		if (!repository) {
			new Notice("未找到 Git 仓库配置");
			return;
		}

		if (!repository.pendingConflict) {
			new Notice(`${getRepositoryFolderDisplayName(this.app, repository)} 没有未完成的冲突`);
			return;
		}

		try {
			const details = await this.gitSyncService.getConflictDetails(repository, repository.pendingConflict.files);
			this.openConflictModal(repository.id, details);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`无法读取冲突文件：${message}`);
		}
	}

	private openConflictModal(repositoryId: string, conflictFiles: GitConflictFile[], operation?: GitConflictOperation) {
		const repository = this.settings.repositories.find((item) => item.id === repositoryId);
		if (!repository) {
			return;
		}
		const conflictOperation = operation ?? repository.pendingConflict?.operation ?? "upload";

		new ConflictResolutionModal(this.app, {
			repositoryName: getRepositoryFolderDisplayName(this.app, repository),
			operationText: getConflictOperationText(conflictOperation),
			conflictFiles,
			onOpenFile: async (filePath) => this.openRepositoryFile(repository.localPath, filePath),
			onResolveFile: async (filePath, resolution) => this.resolveConflictFile(repository.id, filePath, resolution),
			onRefresh: async () => this.refreshConflictDetails(repository.id),
			onContinue: async () => {
				await this.continueConflictRepository(repository.id, true);
			},
		}).open();
	}

	private async resolveConflictFile(
		repositoryId: string,
		filePath: string,
		resolution: GitConflictResolution,
	): Promise<GitConflictFile[]> {
		const repository = this.settings.repositories.find((item) => item.id === repositoryId);
		if (!repository) {
			throw new Error("未找到 Git 仓库配置");
		}

		await this.gitSyncService.resolveConflictFile(repository, filePath, resolution);
		return this.refreshConflictDetails(repository.id);
	}

	private async refreshConflictDetails(repositoryId: string): Promise<GitConflictFile[]> {
		const repository = this.settings.repositories.find((item) => item.id === repositoryId);
		if (!repository) {
			throw new Error("未找到 Git 仓库配置");
		}

		return this.gitSyncService.getConflictDetails(repository, repository.pendingConflict?.files);
	}

	private async openRepositoryFile(repositoryLocalPath: string, repositoryRelativeFilePath: string): Promise<boolean> {
		const repositoryPath = normalizePath(repositoryLocalPath.trim()).replace(/^\/+/, "");
		const filePath = normalizePath(`${repositoryPath}/${repositoryRelativeFilePath}`);
		const file = this.app.vault.getAbstractFileByPath(filePath);

		if (file instanceof TFile) {
			await this.app.workspace.getLeaf("tab").openFile(file);
			new Notice(`已打开文件：${file.path}`);
			return true;
		}

		new Notice(`未找到文件：${filePath}`);
		return false;
	}

	private scheduleAutoSync() {
		this.clearAutoSyncTimers();

		for (const repository of this.settings.repositories) {
			if (!repository.enabled || !repository.autoSync) {
				continue;
			}

			const intervalMinutes = Math.max(1, repository.intervalMinutes);
			const timerId = window.setInterval(() => {
				void this.syncRepository(repository.id, false);
			}, intervalMinutes * 60 * 1000);

			this.syncTimers.push(timerId);
		}
	}

	private clearAutoSyncTimers() {
		for (const timerId of this.syncTimers) {
			window.clearInterval(timerId);
		}

		this.syncTimers = [];
	}

	private getSyncFolderPaths(): string[] {
		return this.settings.repositories
			.filter((repository) => repository.enabled)
			.map((repository) => repository.localPath);
	}

	private updateStatusBar(text?: string) {
		if (text) {
			this.statusBarItemEl.setText(`Multi Git：${text}`);
			return;
		}

		const enabledCount = this.settings.repositories.filter((repository) => repository.enabled).length;
		const autoSyncCount = this.settings.repositories.filter((repository) => repository.enabled && repository.autoSync).length;
		this.statusBarItemEl.setText(`Multi Git：${enabledCount} 个仓库，${autoSyncCount} 个定时`);
	}
}

function getConflictOperationText(operation: GitConflictOperation): string {
	return operation === "sync" ? "拉取" : "上传";
}
