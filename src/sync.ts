import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import { promisify } from "util";
import { App, FileSystemAdapter, normalizePath } from "obsidian";
import type { GitRepositoryConfig } from "./settings";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export interface GitSyncResult {
	message: string;
}

export class GitSyncService {
	constructor(private readonly app: App) {
	}

	async sync(repository: GitRepositoryConfig): Promise<GitSyncResult> {
		this.validateRepository(repository);

		const vaultRoot = await fs.realpath(this.getVaultRoot());
		const repositoryPath = this.resolveVaultPath(vaultRoot, repository.localPath);
		const exists = await pathExists(repositoryPath);

		if (!exists) {
			await this.ensureNoSymlinkPath(vaultRoot, path.dirname(repositoryPath));
			await fs.mkdir(path.dirname(repositoryPath), { recursive: true });
			await this.cloneRepository(repository, vaultRoot, repositoryPath);
			return { message: "已克隆" };
		}

		await this.ensureNoSymlinkPath(vaultRoot, repositoryPath);

		const stats = await fs.lstat(repositoryPath);
		if (!stats.isDirectory()) {
			throw new Error("Vault 目录已存在但不是文件夹");
		}

		const hasGitDirectory = await this.hasGitDirectory(repositoryPath);
		if (!hasGitDirectory) {
			const entries = await fs.readdir(repositoryPath);
			if (entries.length > 0) {
				throw new Error("Vault 目录已存在且不是 Git 仓库");
			}

			await this.cloneRepository(repository, vaultRoot, repositoryPath);
			return { message: "已克隆" };
		}

		await this.ensureOriginMatches(repository, repositoryPath);
		await this.pullRepository(repository, repositoryPath);
		return { message: "已拉取最新内容" };
	}

	private validateRepository(repository: GitRepositoryConfig) {
		const remoteUrl = repository.remoteUrl.trim();
		const branch = repository.branch.trim();

		if (!remoteUrl) {
			throw new Error("缺少 Git 链接");
		}

		if (!isAllowedRemoteUrl(remoteUrl)) {
			throw new Error("Git 链接必须是 HTTPS 或 SSH 地址");
		}

		if (!repository.localPath.trim()) {
			throw new Error("缺少 vault 目录");
		}

		if (branch && !isSafeBranchName(branch)) {
			throw new Error("分支名无效");
		}
	}

	private getVaultRoot(): string {
		const adapter = this.app.vault.adapter;

		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error("Git 同步仅支持桌面端 vault");
		}

		return adapter.getBasePath();
	}

	private resolveVaultPath(vaultRoot: string, vaultRelativePath: string): string {
		const normalizedPath = normalizePath(vaultRelativePath.trim()).replace(/^\/+/, "");

		if (!normalizedPath || normalizedPath === "." || normalizedPath.split("/").includes("..")) {
			throw new Error("Vault 目录必须是有效的相对路径");
		}

		const resolvedPath = path.resolve(vaultRoot, ...normalizedPath.split("/"));
		const relativePath = path.relative(vaultRoot, resolvedPath);

		if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
			throw new Error("Vault 目录必须位于当前 vault 内");
		}

		return resolvedPath;
	}

	private async ensureNoSymlinkPath(vaultRoot: string, targetPath: string) {
		const relativePath = path.relative(vaultRoot, targetPath);
		const parts = relativePath ? relativePath.split(path.sep).filter(Boolean) : [];
		let currentPath = vaultRoot;

		for (const part of parts) {
			currentPath = path.join(currentPath, part);

			try {
				const stats = await fs.lstat(currentPath);
				if (stats.isSymbolicLink()) {
					throw new Error("Vault 目录不能包含符号链接");
				}
			} catch (error) {
				if (isNotFoundError(error)) {
					return;
				}

				throw error;
			}
		}
	}

	private async cloneRepository(repository: GitRepositoryConfig, vaultRoot: string, repositoryPath: string) {
		const args = ["clone"];
		const branch = repository.branch.trim();

		if (branch) {
			args.push("--branch", branch);
		}

		args.push(repository.remoteUrl.trim(), repositoryPath);
		await this.runGit(args, vaultRoot);
	}

	private async ensureOriginMatches(repository: GitRepositoryConfig, repositoryPath: string) {
		let currentRemoteUrl: string;
		try {
			const result = await this.runGit(["remote", "get-url", "origin"], repositoryPath);
			currentRemoteUrl = result.stdout.trim();
		} catch {
			throw new Error("目标目录已有 Git 仓库，但无法读取 origin");
		}

		if (currentRemoteUrl !== repository.remoteUrl.trim()) {
			throw new Error("目标目录已有 Git 仓库，且 origin 与配置的 Git 链接不一致");
		}
	}

	private async pullRepository(repository: GitRepositoryConfig, repositoryPath: string) {
		const branch = repository.branch.trim();

		if (!branch) {
			await this.runGit(["pull", "--ff-only"], repositoryPath);
			return;
		}

		await this.runGit(["fetch", "origin", branch], repositoryPath);

		try {
			await this.runGit(["checkout", branch], repositoryPath);
		} catch {
			await this.runGit(["checkout", "-b", branch, `origin/${branch}`], repositoryPath);
		}

		await this.runGit(["pull", "--ff-only", "origin", branch], repositoryPath);
	}

	private async runGit(args: string[], cwd: string) {
		try {
			const result = await execFileAsync("git", args, {
				cwd,
				timeout: GIT_TIMEOUT_MS,
				maxBuffer: GIT_MAX_BUFFER_BYTES,
			});
			return {
				stdout: String(result.stdout),
				stderr: String(result.stderr),
			};
		} catch (error) {
			throw new Error(normalizeGitError(error));
		}
	}

	private async hasGitDirectory(repositoryPath: string): Promise<boolean> {
		try {
			const stats = await fs.lstat(path.join(repositoryPath, ".git"));
			if (stats.isSymbolicLink()) {
				throw new Error("不支持 .git 符号链接");
			}

			if (!stats.isDirectory()) {
				throw new Error("不支持 .git 文件形式的工作树");
			}

			return true;
		} catch (error) {
			if (isNotFoundError(error)) {
				return false;
			}

			throw error;
		}
	}
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function isAllowedRemoteUrl(value: string): boolean {
	if (value.startsWith("-") || hasControlOrWhitespace(value)) {
		return false;
	}

	if (value.startsWith("https://") || value.startsWith("ssh://")) {
		try {
			const url = new URL(value);
			return Boolean(url.hostname) && (url.protocol === "https:" || url.protocol === "ssh:");
		} catch {
			return false;
		}
	}

	return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value);
}

function isSafeBranchName(value: string): boolean {
	if (
		value.startsWith("-") ||
		value.startsWith("/") ||
		value.endsWith("/") ||
		value.endsWith(".") ||
		value.includes("..") ||
		value.includes("@{") ||
		hasControlOrWhitespace(value) ||
		/[~^:?*[\]\\]/.test(value)
	) {
		return false;
	}

	return value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

function hasControlOrWhitespace(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 31 || code === 127 || character.trim() === "") {
			return true;
		}
	}

	return false;
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function normalizeGitError(error: unknown): string {
	if (error && typeof error === "object") {
		const maybeError = error as { message?: string; stderr?: string; stdout?: string };
		const output = maybeError.stderr || maybeError.stdout || maybeError.message;
		if (output) {
			return redactCredentials(output.trim());
		}
	}

	return "Git 命令执行失败";
}

function redactCredentials(value: string): string {
	return value.replace(/(https?:\/\/)([^/@\s]+)@/g, "$1***@");
}
