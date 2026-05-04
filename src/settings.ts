import { App, PluginSettingTab, Setting, normalizePath } from "obsidian";
import type MultiGitPlugin from "./main";

export type SyncStatus = "never" | "success" | "error";

export interface GitRepositoryConfig {
	id: string;
	name: string;
	remoteUrl: string;
	localPath: string;
	branch: string;
	enabled: boolean;
	autoSync: boolean;
	intervalMinutes: number;
	lastSyncedAt?: string;
	lastSyncStatus: SyncStatus;
	lastSyncMessage?: string;
}

export interface MultiGitSettings {
	repositories: GitRepositoryConfig[];
}

export const DEFAULT_SETTINGS: MultiGitSettings = {
	repositories: [],
};

const DEFAULT_INTERVAL_MINUTES = 30;

export class MultiGitSettingTab extends PluginSettingTab {
	plugin: MultiGitPlugin;

	constructor(app: App, plugin: MultiGitPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Multi Git 同步")
			.setHeading();

		new Setting(containerEl)
			.setName("添加仓库")
			.setDesc("添加一个 Git 远程链接，并指定同步到 vault 内的目录。")
			.addButton((button) => button
				.setButtonText("添加")
				.setCta()
				.onClick(async () => {
					this.plugin.settings.repositories.push(createRepositoryConfig());
					await this.plugin.saveSettingsAndReschedule();
					this.display();
				}));

		if (this.plugin.settings.repositories.length === 0) {
			containerEl.createEl("p", {
				text: "还没有仓库配置。添加仓库后，可以手动同步或启用定时同步。",
				cls: "multi-git-empty",
			});
			return;
		}

		for (const repository of this.plugin.settings.repositories) {
			const sectionEl = containerEl.createDiv({ cls: "multi-git-repository" });
			new Setting(sectionEl)
				.setName(repository.name || repository.localPath || "未命名仓库")
				.setHeading();

			new Setting(sectionEl)
				.setName("启用")
				.setDesc("停用后不会手动或定时同步这个仓库。")
				.addToggle((toggle) => toggle
					.setValue(repository.enabled)
					.onChange(async (value) => {
						repository.enabled = value;
						await this.plugin.saveSettingsAndReschedule();
						this.display();
					}));

			new Setting(sectionEl)
				.setName("名称")
				.setDesc("用于在设置页和通知里识别这个仓库。")
				.addText((text) => text
					.setPlaceholder("例如：个人笔记")
					.setValue(repository.name)
					.onChange(async (value) => {
						repository.name = value.trim();
						await this.plugin.saveSettings();
					}));

			new Setting(sectionEl)
				.setName("Git 链接")
				.setDesc("支持 HTTPS 或 SSH 地址。")
				.addText((text) => text
					.setPlaceholder("https://github.com/user/repo.git")
					.setValue(repository.remoteUrl)
					.onChange(async (value) => {
						repository.remoteUrl = value.trim();
						await this.plugin.saveSettings();
					}));

			new Setting(sectionEl)
				.setName("Vault 目录")
				.setDesc("仓库会同步到这个 vault 内的相对目录。")
				.addText((text) => text
					.setPlaceholder("Git/repo-name")
					.setValue(repository.localPath)
					.onChange(async (value) => {
						repository.localPath = normalizeRepositoryPath(value);
						await this.plugin.saveSettings();
					}));

			new Setting(sectionEl)
				.setName("分支")
				.setDesc("留空时使用仓库默认分支。")
				.addText((text) => text
					.setPlaceholder("默认分支")
					.setValue(repository.branch)
					.onChange(async (value) => {
						repository.branch = value.trim();
						await this.plugin.saveSettings();
					}));

			new Setting(sectionEl)
				.setName("定时同步")
				.setDesc("启用后按设定间隔执行 Git pull。")
				.addToggle((toggle) => toggle
					.setValue(repository.autoSync)
					.onChange(async (value) => {
						repository.autoSync = value;
						await this.plugin.saveSettingsAndReschedule();
					}));

			new Setting(sectionEl)
				.setName("同步间隔")
				.setDesc("单位：分钟，最小 1 分钟。")
				.addText((text) => text
					.setPlaceholder(String(DEFAULT_INTERVAL_MINUTES))
					.setValue(String(repository.intervalMinutes))
					.onChange(async (value) => {
						repository.intervalMinutes = normalizeInterval(value);
						await this.plugin.saveSettingsAndReschedule();
					}));

			new Setting(sectionEl)
				.setName("最近状态")
				.setDesc(formatStatus(repository))
				.addButton((button) => button
					.setButtonText("立即同步")
					.onClick(async () => {
						await this.plugin.syncRepository(repository.id, true);
						this.display();
					}))
				.addButton((button) => button
					.setButtonText("删除")
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.repositories = this.plugin.settings.repositories.filter((item) => item.id !== repository.id);
						await this.plugin.saveSettingsAndReschedule();
						this.display();
					}));
		}
	}
}

function createRepositoryConfig(): GitRepositoryConfig {
	return {
		id: createId(),
		name: "",
		remoteUrl: "",
		localPath: "",
		branch: "",
		enabled: true,
		autoSync: false,
		intervalMinutes: DEFAULT_INTERVAL_MINUTES,
		lastSyncStatus: "never",
	};
}

function createId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeRepositoryPath(value: string): string {
	return normalizePath(value.trim()).replace(/^\/+/, "");
}

function normalizeInterval(value: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_INTERVAL_MINUTES;
	}

	return Math.max(1, parsed);
}

function formatStatus(repository: GitRepositoryConfig): string {
	if (repository.lastSyncStatus === "never") {
		return "尚未同步";
	}

	const time = repository.lastSyncedAt ? new Date(repository.lastSyncedAt).toLocaleString() : "未知时间";
	const message = repository.lastSyncMessage ? `：${repository.lastSyncMessage}` : "";
	const status = repository.lastSyncStatus === "success" ? "成功" : "失败";
	return `${time} ${status}${message}`;
}
