import { Notice, Plugin } from "obsidian";
import { GitSyncService } from "./sync";
import { DEFAULT_SETTINGS, MultiGitSettingTab, MultiGitSettings } from "./settings";

export default class MultiGitPlugin extends Plugin {
	settings: MultiGitSettings;

	private gitSyncService: GitSyncService;
	private syncTimers: number[] = [];
	private syncingRepositoryIds = new Set<string>();
	private statusBarItemEl: HTMLElement;

	async onload() {
		await this.loadSettings();

		this.gitSyncService = new GitSyncService(this.app);

		this.addRibbonIcon("refresh-cw", "同步 Git 仓库", () => {
			void this.syncAllRepositories();
		});

		this.statusBarItemEl = this.addStatusBarItem();
		this.updateStatusBar();

		this.addCommand({
			id: "sync-all-repositories",
			name: "同步所有 Git 仓库",
			callback: () => {
				void this.syncAllRepositories();
			},
		});

		this.register(() => this.clearAutoSyncTimers());
		this.addSettingTab(new MultiGitSettingTab(this.app, this));
		this.scheduleAutoSync();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MultiGitSettings>);
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

		this.updateStatusBar("同步中...");

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
			new Notice(`Git 同步完成：${successCount} 成功，${failedCount} 失败`);
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
				new Notice(`${repository.name || repository.localPath} 正在同步`);
			}
			return false;
		}

		this.syncingRepositoryIds.add(repository.id);
		this.updateStatusBar("同步中...");

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
				new Notice(`${repository.name || repository.localPath} 同步失败：${message}`);
			}
			return false;
		} finally {
			this.syncingRepositoryIds.delete(repository.id);
			this.updateStatusBar();
		}
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
