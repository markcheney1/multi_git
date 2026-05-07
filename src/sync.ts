import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import { promisify } from "util";
import { App, FileSystemAdapter, normalizePath } from "obsidian";
import type { GitConflictState, GitRepositoryConfig } from "./settings";
import {
	buildAuthenticatedRemoteUrl,
	describeRemoteUrl,
	isAllowedRemoteUrl,
	isHttpsRemoteUrl,
	normalizeRemoteUrl,
	stripRemoteUrlCredentials,
} from "./remote-url";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export interface GitSyncResult {
	message: string;
}

export interface GitConflictFile {
	path: string;
	conflictLines: number[];
}

export interface GitUploadConflict {
	branch: string;
	files: string[];
	details: GitConflictFile[];
}

export interface GitUploadResult {
	message: string;
	conflict?: GitUploadConflict;
}

interface RepositoryLocation {
	vaultRoot: string;
	repositoryPath: string;
}

interface RepositoryReady extends RepositoryLocation {
	cloned: boolean;
}

export class GitSyncService {
	constructor(private readonly app: App) {
	}

	async sync(repository: GitRepositoryConfig): Promise<GitSyncResult> {
		const ready = await this.ensureRepository(repository, { allowClone: true });
		if (ready.cloned) {
			return { message: "已克隆" };
		}

		await this.pullRepository(repository, ready.repositoryPath);
		return { message: "已拉取最新内容" };
	}

	async upload(repository: GitRepositoryConfig): Promise<GitUploadResult> {
		const ready = await this.ensureRepository(repository, { allowClone: true });
		if (ready.cloned) {
			return { message: "已拉取最新内容，没有需要上传的本地改动" };
		}

		const branch = await this.prepareUploadBranch(repository, ready.repositoryPath);
		const unmergedFiles = await this.getUnmergedFilePaths(ready.repositoryPath);
		if (unmergedFiles.length > 0) {
			return this.createConflictResult(branch, ready.repositoryPath, unmergedFiles);
		}

		const hadWorktreeChanges = await this.hasWorktreeChanges(ready.repositoryPath);
		if (hadWorktreeChanges) {
			await this.stageAllChanges(ready.repositoryPath);
			await this.runCommit(ready.repositoryPath, ["-m", createAutomaticCommitMessage("Update from Obsidian")]);
		}

		const conflict = await this.mergeRemoteBranch(ready.repositoryPath, branch);
		if (conflict) {
			return conflict;
		}

		const aheadCount = await this.getAheadCount(ready.repositoryPath, branch);
		if (aheadCount === 0) {
			return { message: "已拉取最新内容，没有需要上传的本地改动" };
		}

		await this.runGitWithAuthenticatedOrigin(repository, ["push", "origin", branch], ready.repositoryPath);
		return { message: "已先同步远端更新，并上传本地改动" };
	}

	async continueUpload(repository: GitRepositoryConfig, conflictState: GitConflictState): Promise<GitUploadResult> {
		const ready = await this.ensureRepository(repository, { allowClone: false });
		const branch = conflictState.branch;

		if (!isSafeBranchName(branch)) {
			throw new Error("冲突分支名无效，无法继续上传");
		}

		const currentBranch = await this.getCurrentBranch(ready.repositoryPath);
		if (currentBranch !== branch) {
			throw new Error(`当前分支为 ${currentBranch}，与冲突所在分支 ${branch} 不一致。请先切回 ${branch} 再继续上传`);
		}

		const candidateFiles = conflictState.files.length
			? conflictState.files
			: await this.getUnmergedFilePaths(ready.repositoryPath);
		const markerFiles = await this.findFilesWithConflictMarkers(ready.repositoryPath, candidateFiles);

		if (markerFiles.length > 0) {
			return this.createConflictResult(branch, ready.repositoryPath, markerFiles, "还有冲突内容没有处理完成");
		}

		await this.stageAllChanges(ready.repositoryPath);

		const unresolvedFiles = await this.getUnmergedFilePaths(ready.repositoryPath);
		if (unresolvedFiles.length > 0) {
			return this.createConflictResult(branch, ready.repositoryPath, unresolvedFiles, "还有冲突内容没有处理完成");
		}

		if (await this.isMergeInProgress(ready.repositoryPath)) {
			await this.runCommit(ready.repositoryPath, ["--no-edit"]);
		} else if (await this.hasWorktreeChanges(ready.repositoryPath)) {
			await this.runCommit(ready.repositoryPath, ["-m", createAutomaticCommitMessage("Resolve Obsidian sync conflicts")]);
		}

		const conflict = await this.mergeRemoteBranch(ready.repositoryPath, branch);
		if (conflict) {
			return conflict;
		}

		await this.runGitWithAuthenticatedOrigin(repository, ["push", "origin", branch], ready.repositoryPath);
		return { message: "已提交冲突处理结果，并完成上传" };
	}

	async getConflictDetails(repository: GitRepositoryConfig, files?: string[]): Promise<GitConflictFile[]> {
		const ready = await this.ensureRepository(repository, { allowClone: false });
		const conflictFiles = files && files.length > 0 ? files : await this.getUnmergedFilePaths(ready.repositoryPath);
		return this.getConflictDetailsForPaths(ready.repositoryPath, conflictFiles);
	}

	private validateRepository(repository: GitRepositoryConfig) {
		const remoteUrl = normalizeRemoteUrl(repository.remoteUrl);
		const branch = repository.branch.trim();

		if (!remoteUrl) {
			throw new Error("缺少 Git 链接");
		}

		if (!isAllowedRemoteUrl(remoteUrl)) {
			throw new Error(`Git 链接必须是 HTTPS 或 SSH 地址，当前识别为：${describeRemoteUrl(remoteUrl)}`);
		}

		if (repository.useOAuth2) {
			if (!isHttpsRemoteUrl(remoteUrl)) {
				throw new Error("OAuth2 认证仅支持 HTTPS 地址");
			}
			if (!repository.oauth2Token.trim()) {
				throw new Error("启用 OAuth2 认证后必须填写访问令牌");
			}
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

	private async getRepositoryLocation(repository: GitRepositoryConfig): Promise<RepositoryLocation> {
		this.validateRepository(repository);

		const vaultRoot = await fs.realpath(this.getVaultRoot());
		const repositoryPath = this.resolveVaultPath(vaultRoot, repository.localPath);
		return { vaultRoot, repositoryPath };
	}

	private async ensureRepository(
		repository: GitRepositoryConfig,
		options: { allowClone: boolean },
	): Promise<RepositoryReady> {
		const location = await this.getRepositoryLocation(repository);
		const exists = await pathExists(location.repositoryPath);

		if (!exists) {
			if (!options.allowClone) {
				throw new Error("Vault 目录尚未初始化，请先拉取最新内容");
			}
			await this.ensureNoSymlinkPath(location.vaultRoot, path.dirname(location.repositoryPath));
			await fs.mkdir(path.dirname(location.repositoryPath), { recursive: true });
			await this.cloneRepository(repository, location.repositoryPath);
			return { ...location, cloned: true };
		}

		await this.ensureNoSymlinkPath(location.vaultRoot, location.repositoryPath);

		const stats = await fs.lstat(location.repositoryPath);
		if (!stats.isDirectory()) {
			throw new Error("Vault 目录已存在但不是文件夹");
		}

		const hasGitDirectory = await this.hasGitDirectory(location.repositoryPath);
		if (!hasGitDirectory) {
			if (!options.allowClone) {
				throw new Error("Vault 目录已存在且不是 Git 仓库");
			}
			const entries = await fs.readdir(location.repositoryPath);
			if (entries.length > 0) {
				throw new Error("Vault 目录已存在且不是 Git 仓库");
			}

			await this.cloneRepository(repository, location.repositoryPath);
			return { ...location, cloned: true };
		}

		await this.ensureOriginMatches(repository, location.repositoryPath);
		return { ...location, cloned: false };
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

	private resolveRepositoryFilePath(repositoryPath: string, repositoryRelativePath: string): string {
		const normalizedPath = normalizePath(repositoryRelativePath.trim()).replace(/^\/+/, "");

		if (!normalizedPath || normalizedPath === "." || normalizedPath.split("/").includes("..")) {
			throw new Error("冲突文件路径无效");
		}

		const resolvedPath = path.resolve(repositoryPath, ...normalizedPath.split("/"));
		const relativePath = path.relative(repositoryPath, resolvedPath);

		if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
			throw new Error("冲突文件必须位于 Git 仓库内");
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

	private getAuthenticatedRemoteUrl(repository: GitRepositoryConfig): string {
		const remoteUrl = normalizeRemoteUrl(repository.remoteUrl);
		if (!repository.useOAuth2) {
			return remoteUrl;
		}

		return buildAuthenticatedRemoteUrl(remoteUrl, repository.oauth2Token.trim());
	}

	private async fetchRemoteBranch(repository: GitRepositoryConfig, repositoryPath: string, branch: string) {
		await this.runGitWithAuthenticatedOrigin(
			repository,
			["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
			repositoryPath,
		);
	}

	private async cloneRepository(repository: GitRepositoryConfig, repositoryPath: string) {
		await fs.mkdir(repositoryPath, { recursive: true });
		await this.runGit(["init"], repositoryPath);

		const remoteUrl = normalizeRemoteUrl(repository.remoteUrl);
		await this.runGit(["remote", "add", "origin", remoteUrl], repositoryPath);

		const branch = repository.branch.trim();
		if (branch) {
			await this.fetchRemoteBranch(repository, repositoryPath, branch);
			await this.runGit(["checkout", "-B", branch, `origin/${branch}`], repositoryPath);
			return;
		}

		await this.runGitWithAuthenticatedOrigin(repository, ["fetch", "origin"], repositoryPath);
		await this.runGitWithAuthenticatedOrigin(repository, ["remote", "set-head", "origin", "--auto"], repositoryPath);

		const defaultBranch = await this.getDefaultRemoteBranch(repositoryPath);
		await this.runGit(["checkout", "-B", defaultBranch, `origin/${defaultBranch}`], repositoryPath);
	}

	private async getDefaultRemoteBranch(repositoryPath: string): Promise<string> {
		try {
			const result = await this.runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repositoryPath);
			const remoteHead = result.stdout.trim();
			if (remoteHead.startsWith("origin/")) {
				const branch = remoteHead.slice("origin/".length);
				if (isSafeBranchName(branch)) {
					return branch;
				}
			}
		} catch {
			// Fall through to the user-facing error below.
		}

		throw new Error("无法识别远程默认分支，请在设置中填写分支名");
	}

	private async ensureOriginMatches(repository: GitRepositoryConfig, repositoryPath: string) {
		let currentRemoteUrl: string;
		try {
			const result = await this.runGit(["remote", "get-url", "origin"], repositoryPath);
			currentRemoteUrl = result.stdout.trim();
		} catch {
			throw new Error("目标目录已有 Git 仓库，但无法读取 origin");
		}

		const expectedRemoteUrl = normalizeRemoteUrl(repository.remoteUrl);
		if (stripRemoteUrlCredentials(currentRemoteUrl) !== stripRemoteUrlCredentials(expectedRemoteUrl)) {
			throw new Error("目标目录已有 Git 仓库，且 origin 与配置的 Git 链接不一致");
		}

		if (currentRemoteUrl !== expectedRemoteUrl) {
			await this.runGit(["remote", "set-url", "origin", expectedRemoteUrl], repositoryPath);
		}
	}

	private async pullRepository(repository: GitRepositoryConfig, repositoryPath: string) {
		const branch = repository.branch.trim();

		if (!branch) {
			await this.runGitWithAuthenticatedOrigin(repository, ["pull", "--ff-only"], repositoryPath);
			return;
		}

		await this.fetchRemoteBranch(repository, repositoryPath, branch);

		try {
			await this.runGit(["checkout", branch], repositoryPath);
		} catch {
			await this.runGit(["checkout", "-b", branch, `origin/${branch}`], repositoryPath);
		}

		await this.runGitWithAuthenticatedOrigin(repository, ["pull", "--ff-only", "origin", branch], repositoryPath);
	}

	private async prepareUploadBranch(repository: GitRepositoryConfig, repositoryPath: string): Promise<string> {
		const configured = repository.branch.trim();
		const branch = configured || await this.getCurrentBranch(repositoryPath);

		await this.fetchRemoteBranch(repository, repositoryPath, branch);

		if (configured) {
			try {
				await this.runGit(["checkout", branch], repositoryPath);
			} catch {
				await this.runGit(["checkout", "-b", branch, `origin/${branch}`], repositoryPath);
			}
		}

		return branch;
	}

	private async mergeRemoteBranch(repositoryPath: string, branch: string): Promise<GitUploadResult | undefined> {
		try {
			await this.runGit(["merge", "--no-edit", `origin/${branch}`], repositoryPath);
			return undefined;
		} catch (error) {
			const conflictFiles = await this.getUnmergedFilePaths(repositoryPath);
			if (conflictFiles.length > 0) {
				return this.createConflictResult(branch, repositoryPath, conflictFiles);
			}
			throw error;
		}
	}

	private async getCurrentBranch(repositoryPath: string): Promise<string> {
		const result = await this.runGit(["rev-parse", "--abbrev-ref", "HEAD"], repositoryPath);
		const branch = result.stdout.trim();

		if (!branch || branch === "HEAD") {
			throw new Error("当前仓库未检出分支，无法上传");
		}

		if (!isSafeBranchName(branch)) {
			throw new Error("当前分支名无效，无法上传");
		}

		return branch;
	}

	private async hasWorktreeChanges(repositoryPath: string): Promise<boolean> {
		const result = await this.runGit(["status", "--porcelain"], repositoryPath);
		return result.stdout.trim().length > 0;
	}

	private async stageAllChanges(repositoryPath: string) {
		await this.runGit(["add", "--all"], repositoryPath);
	}

	private async runCommit(repositoryPath: string, commitArgs: string[]) {
		try {
			await this.runGit(["commit", ...commitArgs], repositoryPath);
		} catch (error) {
			if (await this.hasGitIdentity(repositoryPath)) {
				throw error;
			}
			await this.runGit(
				["-c", "user.name=Obsidian", "-c", "user.email=obsidian@local", "commit", ...commitArgs],
				repositoryPath,
			);
		}
	}

	private async hasGitIdentity(repositoryPath: string): Promise<boolean> {
		try {
			const email = await this.runGit(["config", "--get", "user.email"], repositoryPath);
			const name = await this.runGit(["config", "--get", "user.name"], repositoryPath);
			return email.stdout.trim().length > 0 && name.stdout.trim().length > 0;
		} catch {
			return false;
		}
	}

	private async getAheadCount(repositoryPath: string, branch: string): Promise<number> {
		try {
			const result = await this.runGit(["rev-list", "--count", `origin/${branch}..HEAD`], repositoryPath);
			const parsed = Number.parseInt(result.stdout.trim(), 10);
			return Number.isFinite(parsed) ? parsed : 0;
		} catch {
			return 0;
		}
	}

	private async getUnmergedFilePaths(repositoryPath: string): Promise<string[]> {
		const result = await this.runGit(["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=U"], repositoryPath);
		return splitGitOutputLines(result.stdout);
	}

	private async createConflictResult(
		branch: string,
		repositoryPath: string,
		files: string[],
		message = `上传暂停：发现 ${files.length} 个冲突文件`,
	): Promise<GitUploadResult> {
		const uniqueFiles = Array.from(new Set(files)).filter((file) => file.length > 0);
		const details = await this.getConflictDetailsForPaths(repositoryPath, uniqueFiles);

		return {
			message,
			conflict: {
				branch,
				files: uniqueFiles,
				details,
			},
		};
	}

	private async getConflictDetailsForPaths(repositoryPath: string, files: string[]): Promise<GitConflictFile[]> {
		const details: GitConflictFile[] = [];

		for (const file of files) {
			const conflictLines = await this.getConflictLines(repositoryPath, file);
			details.push({ path: file, conflictLines });
		}

		return details;
	}

	private async getConflictLines(repositoryPath: string, file: string): Promise<number[]> {
		const filePath = this.resolveRepositoryFilePath(repositoryPath, file);

		try {
			const content = await fs.readFile(filePath, "utf8");
			const lines = content.split(/\r?\n/);
			const conflictLines: number[] = [];

			for (const [index, line] of lines.entries()) {
				if (isConflictMarkerLine(line)) {
					conflictLines.push(index + 1);
				}
			}

			return conflictLines;
		} catch (error) {
			if (isNotFoundError(error)) {
				return [];
			}

			throw error;
		}
	}

	private async findFilesWithConflictMarkers(repositoryPath: string, files: string[]): Promise<string[]> {
		const markerFiles: string[] = [];

		for (const file of files) {
			const conflictLines = await this.getConflictLines(repositoryPath, file);
			if (conflictLines.length > 0) {
				markerFiles.push(file);
			}
		}

		return markerFiles;
	}

	private async isMergeInProgress(repositoryPath: string): Promise<boolean> {
		return pathExists(path.join(repositoryPath, ".git", "MERGE_HEAD"));
	}

	private async runGitWithAuthenticatedOrigin(repository: GitRepositoryConfig, args: string[], cwd: string) {
		if (!repository.useOAuth2) {
			return this.runGit(args, cwd);
		}

		const remoteUrl = normalizeRemoteUrl(repository.remoteUrl);
		const authenticatedRemoteUrl = this.getAuthenticatedRemoteUrl(repository);
		return this.runGit(["-c", `url.${authenticatedRemoteUrl}.insteadOf=${remoteUrl}`, ...args], cwd);
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

function isConflictMarkerLine(line: string): boolean {
	return CONFLICT_START_MARKER.test(line) || CONFLICT_END_MARKER.test(line);
}

// Match the unique-ish git conflict markers `<<<<<<< <ref>` and `>>>>>>> <ref>`.
// Skip `=======` because Markdown Setext H1 underlines (`======...`) collide with it.
const CONFLICT_START_MARKER = /^<{7}(?:\s|$)/;
const CONFLICT_END_MARKER = /^>{7}(?:\s|$)/;

function splitGitOutputLines(value: string): string[] {
	return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function createAutomaticCommitMessage(prefix: string): string {
	return `${prefix} ${formatTimestamp(new Date())}`;
}

function formatTimestamp(date: Date): string {
	const year = date.getFullYear();
	const month = padNumber(date.getMonth() + 1);
	const day = padNumber(date.getDate());
	const hours = padNumber(date.getHours());
	const minutes = padNumber(date.getMinutes());
	return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function padNumber(value: number): string {
	return value.toString().padStart(2, "0");
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function normalizeGitError(error: unknown): string {
	if (error && typeof error === "object") {
		const maybeError = error as { message?: string; stderr?: string; stdout?: string };
		const output = maybeError.stderr || maybeError.stdout || maybeError.message;
		if (output) {
			return formatFriendlyGitError(redactCredentials(output.trim()));
		}
	}

	return "Git 命令执行失败";
}

function formatFriendlyGitError(value: string): string {
	if (/non-fast-forward|fetch first|rejected/i.test(value)) {
		return "远端在上传过程中发生了更新，请重新上传";
	}

	if (/authentication failed|permission denied|could not read from remote repository/i.test(value)) {
		return "Git 认证失败，请检查 SSH key、访问令牌或远程仓库权限";
	}

	return value;
}

function redactCredentials(value: string): string {
	return value.replace(/(https?:\/\/)([^/@\s]+)@/g, "$1***@");
}
