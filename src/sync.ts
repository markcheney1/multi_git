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
	conflict?: GitOperationConflict;
}

export type GitConflictResolution = "local" | "remote";
export type GitChangedFileResolution = GitConflictResolution;

export interface GitConflictBlock {
	startLine: number;
	separatorLine: number;
	endLine: number;
	localPreview: string;
	remotePreview: string;
}

export interface GitConflictFile {
	path: string;
	conflictLines: number[];
	conflictBlocks: GitConflictBlock[];
}

export interface GitOperationConflict {
	branch: string;
	files: string[];
	details: GitConflictFile[];
}

export interface GitUploadResult {
	message: string;
	conflict?: GitOperationConflict;
}

export interface GitUploadStatus {
	needsUpload: boolean;
	reason: string;
}

export type GitChangedFileKind = "added" | "modified" | "deleted" | "renamed" | "conflict";

export interface GitChangedFile {
	path: string;
	kind: GitChangedFileKind;
	diff: string;
	oldPath?: string;
}

interface RepositoryLocation {
	vaultRoot: string;
	repositoryPath: string;
}

interface RepositoryReady extends RepositoryLocation {
	cloned: boolean;
}

interface GitDiffNameStatus {
	path: string;
	kind: GitChangedFileKind;
	oldPath?: string;
}

interface AutomaticCommitState {
	originalHead: string;
	commitHead: string;
}

export class GitSyncService {
	constructor(private readonly app: App) {
	}

	async sync(repository: GitRepositoryConfig): Promise<GitSyncResult> {
		const ready = await this.ensureRepository(repository, { allowClone: true });
		if (ready.cloned) {
			return { message: "已克隆" };
		}

		const branch = await this.prepareSyncBranch(repository, ready.repositoryPath);
		const hadWorktreeChanges = await this.hasWorktreeChanges(ready.repositoryPath);
		if (hadWorktreeChanges) {
			await this.stageAllChanges(ready.repositoryPath);
			await this.runCommit(ready.repositoryPath, ["-m", createAutomaticCommitMessage("Save local changes before pull")]);
		}

		const conflict = await this.mergeRemoteBranch(ready.repositoryPath, branch);
		if (conflict?.conflict) {
			return conflict;
		}

		return {
			message: hadWorktreeChanges
				? "已拉取服务器更新，并保留本地改动"
				: "已拉取最新内容",
		};
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
		let automaticCommitState: AutomaticCommitState | undefined;
		if (hadWorktreeChanges) {
			const originalHead = await this.getHeadCommit(ready.repositoryPath);
			await this.stageAllChanges(ready.repositoryPath);
			await this.runCommit(ready.repositoryPath, ["-m", createAutomaticCommitMessage("Update from Obsidian")]);
			automaticCommitState = {
				originalHead,
				commitHead: await this.getHeadCommit(ready.repositoryPath),
			};
		}

		const conflict = await this.mergeRemoteBranch(ready.repositoryPath, branch);
		if (conflict) {
			return conflict;
		}

		const aheadCount = await this.getAheadCount(ready.repositoryPath, branch);
		if (aheadCount === 0) {
			return { message: "已拉取最新内容，没有需要上传的本地改动" };
		}

		const pushConflict = await this.pushRepositoryWithRemoteRetry(
			repository,
			ready.repositoryPath,
			branch,
			automaticCommitState,
		);
		if (pushConflict) {
			return pushConflict;
		}
		return { message: "已先同步服务器更新，并上传本地改动" };
	}

	async getUploadStatus(repository: GitRepositoryConfig): Promise<GitUploadStatus> {
		const initialCloneStatus = await this.getInitialCloneUploadStatus(repository);
		if (initialCloneStatus) {
			return initialCloneStatus;
		}

		const ready = await this.ensureRepository(repository, { allowClone: false });

		const unmergedFiles = await this.getUnmergedFilePaths(ready.repositoryPath);
		if (unmergedFiles.length > 0 || await this.isMergeInProgress(ready.repositoryPath)) {
			return {
				needsUpload: true,
				reason: unmergedFiles.length > 0
					? `有 ${unmergedFiles.length} 个冲突文件需要处理后继续上传`
					: "有未完成的合并需要继续上传",
			};
		}

		const branch = repository.branch.trim() || await this.getCurrentBranch(ready.repositoryPath);
		const hasWorktreeChanges = await this.hasWorktreeChanges(ready.repositoryPath);
		const aheadCount = await this.getAheadCount(ready.repositoryPath, branch);

		if (hasWorktreeChanges && aheadCount > 0) {
			return {
				needsUpload: true,
				reason: `有本地改动，且当前分支领先服务器 ${aheadCount} 个提交`,
			};
		}

		if (hasWorktreeChanges) {
			return {
				needsUpload: true,
				reason: "有未提交的本地改动",
			};
		}

		if (aheadCount > 0) {
			return {
				needsUpload: true,
				reason: `当前分支领先服务器 ${aheadCount} 个提交`,
			};
		}

		return {
			needsUpload: false,
			reason: "没有需要上传的本地改动",
		};
	}

	async getChangedFiles(repository: GitRepositoryConfig): Promise<GitChangedFile[]> {
		const ready = await this.ensureRepository(repository, { allowClone: false });
		const branch = repository.branch.trim() || await this.getCurrentBranch(ready.repositoryPath);
		const baseRef = await this.getUploadDiffBaseRef(ready.repositoryPath, branch);
		const unmergedFiles = await this.getUnmergedFilePaths(ready.repositoryPath);
		const unmergedFileSet = new Set(unmergedFiles);
		const changedFiles = new Map<string, GitChangedFile>();

		for (const status of await this.getDiffNameStatuses(ready.repositoryPath, baseRef)) {
			const isConflict = unmergedFileSet.has(status.path) || (status.oldPath ? unmergedFileSet.has(status.oldPath) : false);
			const kind = isConflict ? "conflict" : status.kind;
			changedFiles.set(status.path, {
				...status,
				kind,
				diff: await this.getFileDiff(ready.repositoryPath, baseRef, status),
			});
		}

		for (const file of await this.getUntrackedFilePaths(ready.repositoryPath)) {
			if (changedFiles.has(file)) {
				continue;
			}

			changedFiles.set(file, {
				path: file,
				kind: "added",
				diff: await this.createUntrackedFileDiff(ready.repositoryPath, file),
			});
		}

		for (const file of unmergedFiles) {
			if (changedFiles.has(file)) {
				continue;
			}

			changedFiles.set(file, {
				path: file,
				kind: "conflict",
				diff: await this.getFileDiff(ready.repositoryPath, baseRef, { path: file }),
			});
		}

		return Array.from(changedFiles.values()).sort((left, right) => left.path.localeCompare(right.path));
	}

	async applyChangedFileVersion(
		repository: GitRepositoryConfig,
		file: GitChangedFile,
		resolution: GitChangedFileResolution,
	): Promise<GitChangedFile[]> {
		const ready = await this.ensureRepository(repository, { allowClone: false });

		if (resolution === "local") {
			const resolvedConflictMarkers = await this.resolveConflictFileIfNeeded(ready.repositoryPath, file.path, "local");
			if (!resolvedConflictMarkers && file.kind === "conflict") {
				await this.checkoutConflictSide(ready.repositoryPath, file.path, "ours");
			}
			return this.getChangedFiles(repository);
		}

		if (file.kind === "conflict") {
			const resolvedConflictMarkers = await this.resolveConflictFileIfNeeded(ready.repositoryPath, file.path, "remote");
			if (!resolvedConflictMarkers) {
				await this.checkoutConflictSide(ready.repositoryPath, file.path, "theirs");
			}
			return this.getChangedFiles(repository);
		}

		const branch = repository.branch.trim() || await this.getCurrentBranch(ready.repositoryPath);
		const remoteRef = `origin/${branch}`;
		const hasRemoteRef = await this.hasGitRef(ready.repositoryPath, `refs/remotes/origin/${branch}`);
		if (!hasRemoteRef) {
			throw new Error("还没有服务器分支引用，请先拉取最新内容");
		}

		await this.applyRemoteFileVersion(ready.repositoryPath, remoteRef, file);
		return this.getChangedFiles(repository);
	}

	async continueUpload(repository: GitRepositoryConfig, conflictState: GitConflictState): Promise<GitUploadResult> {
		return this.continueConflict(repository, conflictState, { pushAfterMerge: true });
	}

	async continueSync(repository: GitRepositoryConfig, conflictState: GitConflictState): Promise<GitSyncResult> {
		return this.continueConflict(repository, conflictState, { pushAfterMerge: false });
	}

	private async continueConflict(
		repository: GitRepositoryConfig,
		conflictState: GitConflictState,
		options: { pushAfterMerge: boolean },
	): Promise<GitUploadResult> {
		const ready = await this.ensureRepository(repository, { allowClone: false });
		const branch = conflictState.branch;

		if (!isSafeBranchName(branch)) {
			throw new Error("冲突分支名无效，无法继续处理");
		}

		const currentBranch = await this.getCurrentBranch(ready.repositoryPath);
		if (currentBranch !== branch) {
			throw new Error(`当前分支为 ${currentBranch}，与冲突所在分支 ${branch} 不一致。请先切回 ${branch} 再继续处理`);
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

		if (options.pushAfterMerge) {
			const pushConflict = await this.pushRepositoryWithRemoteRetry(repository, ready.repositoryPath, branch);
			if (pushConflict) {
				return pushConflict;
			}
			return { message: "已提交冲突处理结果，并完成上传" };
		}

		return { message: "已提交冲突处理结果，并完成拉取" };
	}

	async getConflictDetails(repository: GitRepositoryConfig, files?: string[]): Promise<GitConflictFile[]> {
		const ready = await this.ensureRepository(repository, { allowClone: false });
		const conflictFiles = files && files.length > 0 ? files : await this.getUnmergedFilePaths(ready.repositoryPath);
		return this.getConflictDetailsForPaths(ready.repositoryPath, conflictFiles);
	}

	async resolveConflictFile(
		repository: GitRepositoryConfig,
		file: string,
		resolution: GitConflictResolution,
	): Promise<GitConflictFile> {
		const ready = await this.ensureRepository(repository, { allowClone: false });
		const filePath = this.resolveRepositoryFilePath(ready.repositoryPath, file);
		const content = await fs.readFile(filePath, "utf8");
		const resolvedContent = resolveConflictContent(content, resolution);

		await fs.writeFile(filePath, resolvedContent, "utf8");
		return this.getConflictDetailsForPath(ready.repositoryPath, file);
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

	private async getInitialCloneUploadStatus(repository: GitRepositoryConfig): Promise<GitUploadStatus | undefined> {
		const location = await this.getRepositoryLocation(repository);
		const exists = await pathExists(location.repositoryPath);

		if (!exists) {
			await this.ensureNoSymlinkPath(location.vaultRoot, path.dirname(location.repositoryPath));
			return {
				needsUpload: true,
				reason: "Vault 目录尚未初始化，上传会先克隆服务器内容",
			};
		}

		await this.ensureNoSymlinkPath(location.vaultRoot, location.repositoryPath);

		const stats = await fs.lstat(location.repositoryPath);
		if (!stats.isDirectory()) {
			throw new Error("Vault 目录已存在但不是文件夹");
		}

		const hasGitDirectory = await this.hasGitDirectory(location.repositoryPath);
		if (hasGitDirectory) {
			return undefined;
		}

		const entries = await fs.readdir(location.repositoryPath);
		if (entries.length > 0) {
			throw new Error("Vault 目录已存在且不是 Git 仓库");
		}

		return {
			needsUpload: true,
			reason: "Vault 目录为空，上传会先克隆服务器内容",
		};
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

	private async prepareSyncBranch(repository: GitRepositoryConfig, repositoryPath: string): Promise<string> {
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

	private async pushRepositoryWithRemoteRetry(
		repository: GitRepositoryConfig,
		repositoryPath: string,
		branch: string,
		automaticCommitState?: AutomaticCommitState,
	): Promise<GitUploadResult | undefined> {
		try {
			await this.runGitWithAuthenticatedOrigin(repository, ["push", "origin", branch], repositoryPath);
			return undefined;
		} catch (error) {
			if (!isRemoteUpdatedDuringPushError(error)) {
				if (automaticCommitState) {
					await this.rollbackAutomaticCommit(repositoryPath, automaticCommitState, error);
				}
				throw error;
			}
		}

		try {
			await this.fetchRemoteBranch(repository, repositoryPath, branch);
			const conflict = await this.mergeRemoteBranch(repositoryPath, branch);
			if (conflict) {
				return conflict;
			}

			await this.runGitWithAuthenticatedOrigin(repository, ["push", "origin", branch], repositoryPath);
		} catch (error) {
			if (automaticCommitState) {
				await this.rollbackAutomaticCommit(repositoryPath, automaticCommitState, error);
			}
			throw error;
		}
		return undefined;
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

	private async getHeadCommit(repositoryPath: string): Promise<string> {
		const result = await this.runGit(["rev-parse", "HEAD"], repositoryPath);
		return result.stdout.trim();
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

	private async rollbackAutomaticCommit(
		repositoryPath: string,
		state: AutomaticCommitState,
		originalError: unknown,
	) {
		try {
			await this.runGit(["reset", "--hard", state.commitHead], repositoryPath);
			await this.runGit(["reset", "--mixed", state.originalHead], repositoryPath);
		} catch (rollbackError) {
			const originalMessage = originalError instanceof Error ? originalError.message : String(originalError);
			const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
			throw new Error(`${originalMessage}；自动提交回退失败：${rollbackMessage}`);
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

	private async getUploadDiffBaseRef(repositoryPath: string, branch: string): Promise<string> {
		const remoteRef = `origin/${branch}`;
		const hasRemoteRef = await this.hasGitRef(repositoryPath, `refs/remotes/origin/${branch}`);
		if (!hasRemoteRef) {
			return "HEAD";
		}

		return remoteRef;
	}

	private async hasGitRef(repositoryPath: string, ref: string): Promise<boolean> {
		try {
			await this.runGit(["show-ref", "--verify", "--quiet", ref], repositoryPath);
			return true;
		} catch {
			return false;
		}
	}

	private async getDiffNameStatuses(repositoryPath: string, baseRef: string): Promise<GitDiffNameStatus[]> {
		const result = await this.runGit(
			["-c", "core.quotePath=false", "diff", "--name-status", "-z", "--find-renames", baseRef],
			repositoryPath,
		);
		return parseGitDiffNameStatuses(result.stdout);
	}

	private async getUntrackedFilePaths(repositoryPath: string): Promise<string[]> {
		const result = await this.runGit(
			["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "-z"],
			repositoryPath,
		);
		return splitGitOutputRecords(result.stdout);
	}

	private async getFileDiff(
		repositoryPath: string,
		baseRef: string,
		file: Pick<GitDiffNameStatus, "path" | "oldPath">,
	): Promise<string> {
		const pathspecs = file.oldPath ? [file.oldPath, file.path] : [file.path];
		const result = await this.runGit(
			["-c", "core.quotePath=false", "diff", "--no-color", "--find-renames", baseRef, "--", ...pathspecs],
			repositoryPath,
		);
		return result.stdout.trimEnd() || "这个文件没有可显示的文本 diff。";
	}

	private async createUntrackedFileDiff(repositoryPath: string, file: string): Promise<string> {
		const filePath = this.resolveRepositoryFilePath(repositoryPath, file);
		const stats = await fs.lstat(filePath);

		if (!stats.isFile()) {
			return `diff --git a/${file} b/${file}\n新增路径不是普通文件，无法显示文本 diff。`;
		}

		if (stats.size > UNTRACKED_DIFF_MAX_BYTES) {
			return `diff --git a/${file} b/${file}\nnew file mode 100644\n新增文件超过 ${formatBytes(UNTRACKED_DIFF_MAX_BYTES)}，未展开内容。`;
		}

		const content = await fs.readFile(filePath);
		if (isLikelyBinary(content)) {
			return `diff --git a/${file} b/${file}\nnew file mode 100644\n新增文件是二进制内容，无法显示文本 diff。`;
		}

		return createAddedFileDiff(file, content.toString("utf8"));
	}

	private async resolveConflictFileIfNeeded(
		repositoryPath: string,
		file: string,
		resolution: GitConflictResolution,
	): Promise<boolean> {
		const filePath = this.resolveRepositoryFilePath(repositoryPath, file);

		try {
			const content = await fs.readFile(filePath, "utf8");
			const parsed = parseConflictContent(content);
			if (parsed.conflictBlocks.length === 0) {
				return false;
			}

			await fs.writeFile(filePath, resolveConflictContent(content, resolution), "utf8");
			return true;
		} catch (error) {
			if (isNotFoundError(error)) {
				return false;
			}

			throw error;
		}
	}

	private async checkoutConflictSide(repositoryPath: string, file: string, side: "ours" | "theirs") {
		await this.runGit(["checkout", `--${side}`, "--", file], repositoryPath);
	}

	private async applyRemoteFileVersion(
		repositoryPath: string,
		remoteRef: string,
		file: Pick<GitChangedFile, "path" | "oldPath">,
	) {
		if (file.oldPath && file.oldPath !== file.path) {
			await this.removeRepositoryPathIfExists(repositoryPath, file.path);
		}

		const remotePath = file.oldPath && await this.refPathExists(repositoryPath, remoteRef, file.oldPath)
			? file.oldPath
			: file.path;

		if (await this.refPathExists(repositoryPath, remoteRef, remotePath)) {
			await this.runGit(["checkout", remoteRef, "--", remotePath], repositoryPath);
			return;
		}

		await this.removeRepositoryPathIfExists(repositoryPath, file.path);
		if (file.oldPath && file.oldPath !== file.path) {
			await this.removeRepositoryPathIfExists(repositoryPath, file.oldPath);
		}
	}

	private async refPathExists(repositoryPath: string, ref: string, file: string): Promise<boolean> {
		const result = await this.runGit(
			["-c", "core.quotePath=false", "ls-tree", "-z", "--name-only", ref, "--", file],
			repositoryPath,
		);
		return splitGitOutputRecords(result.stdout).includes(file);
	}

	private async removeRepositoryPathIfExists(repositoryPath: string, file: string) {
		const filePath = this.resolveRepositoryFilePath(repositoryPath, file);
		await fs.rm(filePath, { recursive: true, force: true });
	}

	private async createConflictResult(
		branch: string,
		repositoryPath: string,
		files: string[],
		message = `发现 ${files.length} 个冲突文件`,
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
			details.push(await this.getConflictDetailsForPath(repositoryPath, file));
		}

		return details;
	}

	private async getConflictDetailsForPath(repositoryPath: string, file: string): Promise<GitConflictFile> {
		const filePath = this.resolveRepositoryFilePath(repositoryPath, file);

		try {
			const content = await fs.readFile(filePath, "utf8");
			const parsed = parseConflictContent(content);
			return {
				path: file,
				conflictLines: parsed.conflictLines,
				conflictBlocks: parsed.conflictBlocks,
			};
		} catch (error) {
			if (isNotFoundError(error)) {
				return {
					path: file,
					conflictLines: [],
					conflictBlocks: [],
				};
			}

			throw error;
		}
	}

	private async getConflictLines(repositoryPath: string, file: string): Promise<number[]> {
		const details = await this.getConflictDetailsForPath(repositoryPath, file);
		return details.conflictLines;
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

// Match the unique-ish git conflict markers `<<<<<<< <ref>` and `>>>>>>> <ref>`.
// Skip `=======` because Markdown Setext H1 underlines (`======...`) collide with it.
const CONFLICT_START_MARKER = /^<{7}(?:\s|$)/;
const CONFLICT_SEPARATOR_MARKER = /^={7}(?:\s|$)/;
const CONFLICT_END_MARKER = /^>{7}(?:\s|$)/;
const CONFLICT_PREVIEW_MAX_LINES = 8;
const CONFLICT_PREVIEW_MAX_CHARS = 600;
const UNTRACKED_DIFF_MAX_BYTES = 256 * 1024;

interface ParsedConflictContent {
	conflictLines: number[];
	conflictBlocks: GitConflictBlock[];
}

interface ContentLines {
	lines: string[];
	newline: string;
	hasTrailingNewline: boolean;
}

function parseConflictContent(content: string): ParsedConflictContent {
	const { lines } = splitContentLines(content);
	const conflictLines: number[] = [];
	const conflictBlocks: GitConflictBlock[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (!CONFLICT_START_MARKER.test(line)) {
			if (CONFLICT_END_MARKER.test(line)) {
				conflictLines.push(index + 1);
			}
			index += 1;
			continue;
		}

		const startIndex = index;
		const separatorIndex = findMarkerIndex(lines, startIndex + 1, CONFLICT_SEPARATOR_MARKER);
		const endIndex = separatorIndex === -1
			? -1
			: findMarkerIndex(lines, separatorIndex + 1, CONFLICT_END_MARKER);

		if (separatorIndex === -1 || endIndex === -1) {
			conflictLines.push(startIndex + 1);
			index = startIndex + 1;
			continue;
		}

		conflictLines.push(startIndex + 1, separatorIndex + 1, endIndex + 1);
		conflictBlocks.push({
			startLine: startIndex + 1,
			separatorLine: separatorIndex + 1,
			endLine: endIndex + 1,
			localPreview: formatConflictPreview(lines.slice(startIndex + 1, separatorIndex)),
			remotePreview: formatConflictPreview(lines.slice(separatorIndex + 1, endIndex)),
		});
		index = endIndex + 1;
	}

	return { conflictLines, conflictBlocks };
}

function resolveConflictContent(content: string, resolution: GitConflictResolution): string {
	const parts = splitContentLines(content);
	const resolvedLines: string[] = [];
	let index = 0;
	let resolvedBlockCount = 0;

	while (index < parts.lines.length) {
		const line = parts.lines[index] ?? "";
		if (!CONFLICT_START_MARKER.test(line)) {
			resolvedLines.push(line);
			index += 1;
			continue;
		}

		const startIndex = index;
		const separatorIndex = findMarkerIndex(parts.lines, startIndex + 1, CONFLICT_SEPARATOR_MARKER);
		const endIndex = separatorIndex === -1
			? -1
			: findMarkerIndex(parts.lines, separatorIndex + 1, CONFLICT_END_MARKER);

		if (separatorIndex === -1 || endIndex === -1) {
			resolvedLines.push(line);
			index += 1;
			continue;
		}

		const selectedLines = resolution === "local"
			? parts.lines.slice(startIndex + 1, separatorIndex)
			: parts.lines.slice(separatorIndex + 1, endIndex);
		resolvedLines.push(...selectedLines);
		resolvedBlockCount += 1;
		index = endIndex + 1;
	}

	if (resolvedBlockCount === 0) {
		throw new Error("没有检测到可自动处理的标准 Git 冲突块");
	}

	return resolvedLines.join(parts.newline) + (parts.hasTrailingNewline ? parts.newline : "");
}

function findMarkerIndex(lines: string[], fromIndex: number, marker: RegExp): number {
	for (let index = fromIndex; index < lines.length; index += 1) {
		if (marker.test(lines[index] ?? "")) {
			return index;
		}
	}

	return -1;
}

function splitContentLines(content: string): ContentLines {
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	const hasTrailingNewline = content.endsWith("\n");
	const lines = content.split(/\r?\n/);

	if (hasTrailingNewline) {
		lines.pop();
	}

	return { lines, newline, hasTrailingNewline };
}

function formatConflictPreview(lines: string[]): string {
	const visibleLines = lines.slice(0, CONFLICT_PREVIEW_MAX_LINES);
	let preview = visibleLines.join("\n").trim();
	const hiddenLineCount = lines.length - visibleLines.length;

	if (preview.length > CONFLICT_PREVIEW_MAX_CHARS) {
		preview = `${preview.slice(0, CONFLICT_PREVIEW_MAX_CHARS).trimEnd()}\n...`;
	} else if (hiddenLineCount > 0) {
		preview = `${preview}\n...`;
	}

	return preview || "空内容";
}

function splitGitOutputLines(value: string): string[] {
	return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function splitGitOutputRecords(value: string): string[] {
	return value
		.split("\0")
		.filter((record) => record.length > 0);
}

function parseGitDiffNameStatuses(value: string): GitDiffNameStatus[] {
	const records = splitGitOutputRecords(value);
	const statuses: GitDiffNameStatus[] = [];
	let index = 0;

	while (index < records.length) {
		const status = records[index] ?? "";
		index += 1;

		if (status.startsWith("R") || status.startsWith("C")) {
			const oldPath = records[index] ?? "";
			const path = records[index + 1] ?? "";
			index += 2;

			if (path) {
				statuses.push({
					path,
					oldPath,
					kind: status.startsWith("R") ? "renamed" : "added",
				});
			}
			continue;
		}

		const path = records[index] ?? "";
		index += 1;
		const kind = parseGitDiffKind(status);
		if (path && kind) {
			statuses.push({ path, kind });
		}
	}

	return statuses;
}

function parseGitDiffKind(status: string): GitChangedFileKind | undefined {
	if (status.includes("U")) {
		return "conflict";
	}

	switch (status.charAt(0)) {
		case "A":
			return "added";
		case "D":
			return "deleted";
		case "M":
		case "T":
			return "modified";
		default:
			return undefined;
	}
}

function createAddedFileDiff(file: string, content: string): string {
	const parts = splitContentLines(content);
	const lines = [
		`diff --git a/${file} b/${file}`,
		"new file mode 100644",
		"--- /dev/null",
		`+++ b/${file}`,
		`@@ -0,0 +1,${parts.lines.length} @@`,
		...parts.lines.map((line) => `+${line}`),
	];

	return lines.join("\n") + (parts.hasTrailingNewline ? "\n" : "");
}

function isLikelyBinary(content: Uint8Array): boolean {
	return content.includes(0);
}

function formatBytes(value: number): string {
	if (value < 1024) {
		return `${value} B`;
	}

	return `${Math.round(value / 1024)} KB`;
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
		return "服务器在上传过程中发生了更新，请重新上传";
	}

	if (/authentication failed|permission denied|could not read from remote repository/i.test(value)) {
		return "Git 认证失败，请检查 SSH key、访问令牌或远程仓库权限";
	}

	return value;
}

function redactCredentials(value: string): string {
	return value.replace(/(https?:\/\/)([^/@\s]+)@/g, "$1***@");
}

function isRemoteUpdatedDuringPushError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /服务器在上传过程中发生了更新|远端在上传过程中发生了更新|non-fast-forward|fetch first|rejected/i.test(message);
}
