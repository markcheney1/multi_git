import { App, PluginSettingTab, Setting, TFolder, normalizePath } from "obsidian";
import type MultiGitPlugin from "./main";
import { normalizeRemoteUrl } from "./remote-url";

export type SyncStatus = "never" | "success" | "error";
export type GitConflictOperation = "sync" | "upload";

export interface GitConflictState {
	branch: string;
	files: string[];
	startedAt: string;
	operation: GitConflictOperation;
}

export interface GitRepositoryConfig {
	id: string;
	name: string;
	remoteUrl: string;
	localPath: string;
	branch: string;
	enabled: boolean;
	useOAuth2: boolean;
	oauth2Token: string;
	autoSync: boolean;
	intervalMinutes: number;
	lastSyncedAt?: string;
	lastSyncStatus: SyncStatus;
	lastSyncMessage?: string;
	lastUploadedAt?: string;
	lastUploadStatus: SyncStatus;
	lastUploadMessage?: string;
	pendingConflict?: GitConflictState;
}

export interface MultiGitSettings {
	repositories: GitRepositoryConfig[];
	folderBadgeText: string;
}

export const DEFAULT_SETTINGS: MultiGitSettings = {
	repositories: [],
	folderBadgeText: "请勿修改",
};

const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_FOLDER_BADGE_TEXT = DEFAULT_SETTINGS.folderBadgeText;

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
			.setName("同步目录角标")
			.setDesc("显示在同步目录旁边的短文字。留空时使用“请勿修改”。")
			.addText((text) => text
				.setPlaceholder(DEFAULT_FOLDER_BADGE_TEXT)
				.setValue(this.plugin.settings.folderBadgeText)
				.onChange(async (value) => {
					this.plugin.settings.folderBadgeText = normalizeFolderBadgeText(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("添加仓库")
			.setDesc("添加一个 Git 远程链接，并指定同步到 vault 内的目录。")
			.addButton((button) => button
				.setButtonText("添加")
				.setCta()
				.onClick(async () => {
					this.plugin.settings.repositories.unshift(createRepositoryConfig());
					await this.plugin.saveSettingsAndReschedule();
					this.display();
				}));

		if (this.plugin.settings.repositories.length === 0) {
			containerEl.createEl("p", {
				text: "还没有仓库配置。添加仓库后，可以手动拉取、上传或启用定时拉取。",
				cls: "multi-git-empty",
			});
			return;
		}

		for (const repository of this.plugin.settings.repositories) {
			const sectionEl = containerEl.createDiv({ cls: "multi-git-repository" });
			new Setting(sectionEl)
				.setName(getRepositoryFolderDisplayName(this.app, repository))
				.setDesc(repository.name ? `配置名称：${repository.name}` : "")
				.setHeading();

			new Setting(sectionEl)
				.setName("启用")
				.setDesc("停用后不会手动拉取、上传或定时拉取这个仓库。")
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
				.setDesc("支持带端口的远程地址。")
				.addText((text) => text
					.setPlaceholder("ssh://git@example.com:2222/user/repo.git")
					.setValue(repository.remoteUrl)
					.onChange(async (value) => {
						repository.remoteUrl = normalizeRemoteUrl(value);
						await this.plugin.saveSettings();
					}));

			new Setting(sectionEl)
				.setName("访问令牌认证")
				.setDesc("启用后会把访问令牌用于 HTTPS Git 认证。")
				.addToggle((toggle) => toggle
					.setValue(repository.useOAuth2)
					.onChange(async (value) => {
						repository.useOAuth2 = value;
						await this.plugin.saveSettings();
						this.display();
					}));

			if (repository.useOAuth2) {
				new Setting(sectionEl)
					.setName("访问令牌")
					.setDesc("仅在本机保存，请确认仓库支持以 oauth2 用户名 + 令牌作为密码访问。")
					.addText((text) => {
						text.inputEl.type = "password";
						text.setPlaceholder("访问令牌")
							.setValue(repository.oauth2Token)
							.onChange(async (value) => {
								repository.oauth2Token = value.trim();
								await this.plugin.saveSettings();
							});
					});
			}

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
				.setName("定时拉取")
				.setDesc("启用后按设定间隔执行 Git pull。")
				.addToggle((toggle) => toggle
					.setValue(repository.autoSync)
					.onChange(async (value) => {
						repository.autoSync = value;
						await this.plugin.saveSettingsAndReschedule();
					}));

			new Setting(sectionEl)
				.setName("拉取间隔")
				.setDesc("单位：分钟，最小 1 分钟。")
				.addText((text) => text
					.setPlaceholder(String(DEFAULT_INTERVAL_MINUTES))
					.setValue(String(repository.intervalMinutes))
					.onChange(async (value) => {
						repository.intervalMinutes = normalizeInterval(value);
						await this.plugin.saveSettingsAndReschedule();
					}));

			if (repository.pendingConflict) {
				const conflictOperationText = getConflictOperationText(repository.pendingConflict.operation);
				new Setting(sectionEl)
					.setName(`${conflictOperationText}暂停`)
					.setDesc(formatConflictStatus(repository))
					.addButton((button) => button
						.setButtonText("查看冲突")
						.onClick(async () => {
							await this.plugin.showConflictResolution(repository.id);
							this.display();
						}))
					.addButton((button) => button
						.setButtonText(`继续${conflictOperationText}`)
						.setCta()
						.onClick(async () => {
							await this.plugin.continueConflictRepository(repository.id, true);
							this.display();
						}));
			}

			new Setting(sectionEl)
				.setName("最近拉取")
				.setDesc(formatStatus({ status: repository.lastSyncStatus, at: repository.lastSyncedAt, message: repository.lastSyncMessage }, "尚未拉取"))
				.addButton((button) => button
					.setButtonText("拉取最新内容")
					.onClick(async () => {
						await this.plugin.syncRepository(repository.id, true);
						this.display();
					}));

			new Setting(sectionEl)
				.setName("最近上传")
				.setDesc(formatStatus({ status: repository.lastUploadStatus, at: repository.lastUploadedAt, message: repository.lastUploadMessage }, "尚未上传"))
				.addButton((button) => button
					.setButtonText("查看 diff")
					.onClick(async () => {
						await this.plugin.showRepositoryDiff(repository.id);
					}))
				.addButton((button) => {
					button
						.setButtonText("上传本地改动")
						.setDisabled(Boolean(repository.pendingConflict))
						.onClick(async () => {
							await this.plugin.uploadRepository(repository.id, true);
							this.display();
						});
				})
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

export function normalizeSettings(data?: Partial<MultiGitSettings> | null): MultiGitSettings {
	const repositories = Array.isArray(data?.repositories)
		? data.repositories.map((repository) => normalizeRepositoryConfig(repository))
		: [];

	return {
		...DEFAULT_SETTINGS,
		...(data ?? {}),
		repositories,
		folderBadgeText: normalizeFolderBadgeText(data?.folderBadgeText),
	};
}

export function getRepositoryFolderDisplayName(app: App, repository: Pick<GitRepositoryConfig, "localPath">): string {
	const normalizedPath = normalizeRepositoryPath(repository.localPath).replace(/\/+$/g, "");
	const folder = app.vault.getAbstractFileByPath(normalizedPath);
	if (folder instanceof TFolder) {
		return folder.name;
	}

	const parts = normalizedPath.split("/").filter((part) => part.length > 0);
	return parts.at(-1) || normalizedPath || "未命名目录";
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
		useOAuth2: false,
		oauth2Token: "",
		lastSyncStatus: "never",
		lastUploadStatus: "never",
	};
}

function normalizeRepositoryConfig(repository: Partial<GitRepositoryConfig>): GitRepositoryConfig {
	return {
		id: repository.id || createId(),
		name: repository.name || "",
		remoteUrl: normalizeRemoteUrl(repository.remoteUrl || ""),
		localPath: repository.localPath || "",
		branch: repository.branch || "",
		enabled: repository.enabled ?? true,
		useOAuth2: repository.useOAuth2 ?? false,
		oauth2Token: typeof repository.oauth2Token === "string" ? repository.oauth2Token : "",
		autoSync: repository.autoSync ?? false,
		intervalMinutes: normalizeInterval(String(repository.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES)),
		lastSyncedAt: repository.lastSyncedAt,
		lastSyncStatus: repository.lastSyncStatus ?? "never",
		lastSyncMessage: repository.lastSyncMessage,
		lastUploadedAt: repository.lastUploadedAt,
		lastUploadStatus: repository.lastUploadStatus ?? "never",
		lastUploadMessage: repository.lastUploadMessage,
		pendingConflict: normalizeConflictState(repository.pendingConflict),
	};
}

function normalizeConflictState(value?: Partial<GitConflictState>): GitConflictState | undefined {
	if (!value || !value.branch || !value.startedAt || !Array.isArray(value.files)) {
		return undefined;
	}

	return {
		branch: value.branch,
		files: value.files.filter((file) => typeof file === "string" && file.length > 0),
		startedAt: value.startedAt,
		operation: value.operation === "sync" ? "sync" : "upload",
	};
}

function createId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeRepositoryPath(value: string): string {
	return normalizePath(value.trim()).replace(/^\/+/, "");
}

function normalizeFolderBadgeText(value?: string): string {
	return value?.trim() || DEFAULT_FOLDER_BADGE_TEXT;
}

function normalizeInterval(value: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_INTERVAL_MINUTES;
	}

	return Math.max(1, parsed);
}

function formatStatus(record: { status: SyncStatus; at?: string; message?: string }, neverText: string): string {
	if (record.status === "never") {
		return neverText;
	}

	const time = record.at ? new Date(record.at).toLocaleString() : "未知时间";
	const statusText = record.status === "success" ? "成功" : "失败";
	const detail = record.message ? `：${record.message}` : "";
	return `${time} ${statusText}${detail}`;
}

function formatConflictStatus(repository: GitRepositoryConfig): string {
	const conflict = repository.pendingConflict;
	if (!conflict) {
		return "";
	}

	const time = new Date(conflict.startedAt).toLocaleString();
	return `${time} 发现 ${conflict.files.length} 个冲突文件。处理完成后选择“继续${getConflictOperationText(conflict.operation)}”。`;
}

function getConflictOperationText(operation: GitConflictOperation): string {
	return operation === "sync" ? "拉取" : "上传";
}
