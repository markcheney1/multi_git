import { normalizePath } from "obsidian";

export function normalizeFolderPath(path: string): string | null {
	const normalizedPath = normalizePath(path.trim()).replace(/^\/+|\/+$/g, "");

	if (!normalizedPath || normalizedPath === "." || normalizedPath.split("/").includes("..")) {
		return null;
	}

	return normalizedPath;
}
