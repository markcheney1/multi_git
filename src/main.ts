import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import { GitSyncService } from "./sync";
import { MultiGitSettingTab, MultiGitSettings, normalizeSettings } from "./settings";
import { ConflictResolutionModal } from "./ui/conflict-modal";

export default class MultiGitPlugin extends Plugin {
	settings: MultiGitSettings;

	private gitSyncService: GitSyncService;
	private syncTimers: number[] = [];
	private syncingRepositoryIds = new Set<string>();
	private statusBarItemEl: HTMLElement;

	async onload() {
		await this.loadSettings();

		this.gitSyncService = new GitSyncService(this.app);

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
		this.addSettingTab(new MultiGitSettingTab(this.app, this));
		this.scheduleAutoSync();
	}

	async loadSettings() {
		this.settings = normalizeSettings(await this.loadData() as Partial<MultiGitSettings> | null);
	}

	async saveSettings() {
		await this.saveData(this.settings);
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

		for (const repository of repositories) {
			const success = await this.syncRepository(repository.id, false);
			if (success) {
				successCount += 1;
			} else {
				failedCount += 1;
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
				new Notice(`${repository.name || repository.localPath} 已停用`);
			}
			return false;
		}

		if (this.syncingRepositoryIds.has(repository.id)) {
			if (showNotice) {
				new Notice(`${repository.name || repository.localPath} 正在处理`);
			}
			return false;
		}

		if (repository.pendingConflict) {
			if (showNotice) {
				new Notice(`${repository.name || repository.localPath} 有未完成的上传冲突，请处理后继续上传`);
				await this.showConflictResolution(repository.id);
			}
			return false;
		}

		this.syncingRepositoryIds.add(repository.id);
		this.updateStatusBar("拉取中...");

		try {
			const result = await this.gitSyncService.sync(repository);
			repository.lastSyncedAt = new Date().toISOString();
			repository.lastSyncStatus = "success";
			repository.lastSyncMessage = result.message;
			await this.saveSettings();

			if (showNotice) {
				new Notice(`${repository.name || repository.localPath}：${result.message}`);
			}
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			repository.lastSyncedAt = new Date().toISOString();
			repository.lastSyncStatus = "error";
			repository.lastSyncMessage = message;
			await this.saveSettings();

			if (showNotice) {
				new Notice(`${repository.name || repository.localPath} 拉取失败：${message}`);
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

		this.updateStatusBar("上传中...");

		let successCount = 0;
		let failedCount = 0;

		for (const repository of repositories) {
			const success = await this.uploadRepository(repository.id, false);
			if (success) {
				successCount += 1;
			} else {
				failedCount += 1;
			}
		}

		this.updateStatusBar();

		if (showNotice) {
			new Notice(`Git 上传完成：${successCount} 成功，${failedCount} 失败或暂停`);
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

		const repositoryName = repository.name || repository.localPath;

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
				new Notice(`${repositoryName} 有未完成的上传冲突，请处理后继续上传`);
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
				};
				repository.lastUploadStatus = "error";
				await this.saveSettings();

				if (showNotice) {
					new Notice(`${repositoryName} 上传暂停：发现 ${result.conflict.files.length} 个冲突文件`);
					this.openConflictModal(repository.id, result.conflict.details);
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

		const repositoryName = repository.name || repository.localPath;

		if (!repository.pendingConflict) {
			if (showNotice) {
				new Notice(`${repositoryName} 没有未完成的上传冲突`);
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
				};
				repository.lastUploadStatus = "error";
				await this.saveSettings();

				if (showNotice) {
					new Notice(`${repositoryName} 仍有冲突需要处理`);
					this.openConflictModal(repository.id, result.conflict.details);
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

	async showConflictResolution(repositoryId: string): Promise<void> {
		const repository = this.settings.repositories.find((item) => item.id === repositoryId);

		if (!repository) {
			new Notice("未找到 Git 仓库配置");
			return;
		}

		if (!repository.pendingConflict) {
			new Notice(`${repository.name || repository.localPath} 没有未完成的上传冲突`);
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

	private openConflictModal(repositoryId: string, conflictFiles: Array<{ path: string; conflictLines: number[] }>) {
		const repository = this.settings.repositories.find((item) => item.id === repositoryId);
		if (!repository) {
			return;
		}

		new ConflictResolutionModal(this.app, {
			repositoryName: repository.name || repository.localPath,
			conflictFiles,
			onOpenFile: async (filePath) => this.openRepositoryFile(repository.localPath, filePath),
			onContinue: async () => {
				await this.continueUploadRepository(repository.id, true);
			},
		}).open();
	}

	private async openRepositoryFile(repositoryLocalPath: string, repositoryRelativeFilePath: string) {
		const repositoryPath = normalizePath(repositoryLocalPath.trim()).replace(/^\/+/, "");
		const filePath = normalizePath(`${repositoryPath}/${repositoryRelativeFilePath}`);
		const file = this.app.vault.getAbstractFileByPath(filePath);

		if (file instanceof TFile) {
			await this.app.workspace.getLeaf(false).openFile(file);
			return;
		}

		new Notice(`未找到冲突文件：${filePath}`);
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
