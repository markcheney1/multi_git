import { App, normalizePath } from "obsidian";

const FOLDER_TITLE_SELECTOR = ".nav-folder-title[data-path]";
const SYNC_FOLDER_CLASS = "multi-git-sync-folder";
const SYNC_BADGE_CLASS = "multi-git-sync-folder-badge";

export class SyncFolderBadgeManager {
	private observer?: MutationObserver;
	private refreshQueued = false;
	private refreshFrameId?: number;
	private started = false;

	constructor(
		private readonly app: App,
		private readonly getSyncFolderPaths: () => string[],
	) {
	}

	start() {
		this.started = true;

		this.app.workspace.onLayoutReady(() => {
			if (!this.started) {
				return;
			}

			this.refresh();

			if (this.observer) {
				return;
			}

			this.observer = new MutationObserver(() => {
				this.refresh();
			});

			this.observer.observe(this.app.workspace.containerEl, {
				attributes: true,
				attributeFilter: ["data-path"],
				childList: true,
				subtree: true,
			});
		});
	}

	stop() {
		this.started = false;
		this.observer?.disconnect();
		this.observer = undefined;

		if (this.refreshFrameId !== undefined) {
			window.cancelAnimationFrame(this.refreshFrameId);
			this.refreshFrameId = undefined;
		}

		this.refreshQueued = false;
		this.clearBadges();
	}

	refresh() {
		if (!this.started || this.refreshQueued) {
			return;
		}

		this.refreshQueued = true;
		this.refreshFrameId = window.requestAnimationFrame(() => {
			this.refreshFrameId = undefined;

			if (!this.started) {
				this.refreshQueued = false;
				return;
			}

			this.refreshQueued = false;
			this.applyBadges();
		});
	}

	private applyBadges() {
		const syncFolderPaths = new Set(
			this.getSyncFolderPaths()
				.map((path) => normalizeFolderPath(path))
				.filter((path): path is string => Boolean(path)),
		);

		const folderTitles = Array.from(this.app.workspace.containerEl.querySelectorAll<HTMLElement>(FOLDER_TITLE_SELECTOR));
		for (const folderTitleEl of folderTitles) {
			const folderPath = normalizeFolderPath(folderTitleEl.dataset.path ?? "");

			if (folderPath && syncFolderPaths.has(folderPath)) {
				this.addBadge(folderTitleEl);
			} else {
				this.removeBadge(folderTitleEl);
			}
		}

		const staleBadgeTargets = Array.from(this.app.workspace.containerEl.querySelectorAll<HTMLElement>(`.${SYNC_FOLDER_CLASS}`));
		for (const targetEl of staleBadgeTargets) {
			if (!targetEl.matches(FOLDER_TITLE_SELECTOR)) {
				this.removeBadge(targetEl);
				continue;
			}

			const folderPath = normalizeFolderPath(targetEl.dataset.path ?? "");
			if (!folderPath || !syncFolderPaths.has(folderPath)) {
				this.removeBadge(targetEl);
			}
		}
	}

	private addBadge(folderTitleEl: HTMLElement) {
		folderTitleEl.classList.add(SYNC_FOLDER_CLASS);
		folderTitleEl.setAttribute("data-multi-git-sync-folder", "true");

		if (findBadgeEl(folderTitleEl)) {
			return;
		}

		const badgeEl = document.createElement("span");
		badgeEl.className = SYNC_BADGE_CLASS;
		badgeEl.textContent = "同步";
		badgeEl.setAttribute("aria-label", "同步目录");
		badgeEl.setAttribute("title", "同步目录");
		folderTitleEl.appendChild(badgeEl);
	}

	private removeBadge(folderTitleEl: HTMLElement) {
		folderTitleEl.classList.remove(SYNC_FOLDER_CLASS);
		folderTitleEl.removeAttribute("data-multi-git-sync-folder");

		findBadgeEl(folderTitleEl)?.remove();
	}

	private clearBadges() {
		const markedFolderTitleEls = Array.from(this.app.workspace.containerEl.querySelectorAll<HTMLElement>(`.${SYNC_FOLDER_CLASS}`));
		for (const folderTitleEl of markedFolderTitleEls) {
			this.removeBadge(folderTitleEl);
		}

		const orphanBadgeEls = Array.from(this.app.workspace.containerEl.querySelectorAll<HTMLElement>(`.${SYNC_BADGE_CLASS}`));
		for (const badgeEl of orphanBadgeEls) {
			badgeEl.remove();
		}
	}
}

function normalizeFolderPath(path: string): string | null {
	const normalizedPath = normalizePath(path.trim()).replace(/^\/+|\/+$/g, "");

	if (!normalizedPath || normalizedPath === "." || normalizedPath.split("/").includes("..")) {
		return null;
	}

	return normalizedPath;
}

function findBadgeEl(folderTitleEl: HTMLElement): HTMLElement | null {
	for (const childEl of Array.from(folderTitleEl.children)) {
		if (childEl instanceof HTMLElement && childEl.classList.contains(SYNC_BADGE_CLASS)) {
			return childEl;
		}
	}

	return null;
}
