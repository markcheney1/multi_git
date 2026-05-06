export function normalizeRemoteUrl(value: string): string {
	const normalized = value
		.normalize("NFKC")
		.trim()
		.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
		.replace(/\s+/g, "");

	return normalized.replace(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//, (scheme) => scheme.toLowerCase());
}

export function isAllowedRemoteUrl(value: string): boolean {
	if (value.startsWith("-") || hasControlOrWhitespace(value)) {
		return false;
	}

	const scheme = getRemoteUrlScheme(value);
	if (scheme === "https") {
		return isAllowedHttpsUrl(value);
	}

	if (scheme === "ssh") {
		return isAllowedSshUrl(value);
	}

	return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value);
}

export function describeRemoteUrl(value: string): string {
	const scheme = getRemoteUrlScheme(value);
	if (scheme === "https") {
		return "HTTPS";
	}

	if (scheme === "ssh") {
		return "SSH";
	}

	if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+:/.test(value)) {
		return "SSH scp 格式";
	}

	if (value.length === 0) {
		return "空";
	}

	const fallbackScheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)?.[1];
	if (fallbackScheme) {
		return `${fallbackScheme} 协议`;
	}

	return "未知格式";
}

function getRemoteUrlScheme(value: string): string | undefined {
	const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value);
	return match?.[1]?.toLowerCase();
}

function isAllowedHttpsUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return Boolean(url.hostname) && url.protocol === "https:";
	} catch {
		return false;
	}
}

function isAllowedSshUrl(value: string): boolean {
	const match = /^ssh:\/\/(?:([A-Za-z0-9._%+-]+)@)?([A-Za-z0-9.-]+)(?::(\d+))?\/(.+)$/.exec(value);
	if (!match) {
		return false;
	}

	const host = match[2];
	const port = match[3];
	const repositoryPath = match[4];

	if (!host || !repositoryPath || repositoryPath.startsWith("-")) {
		return false;
	}

	if (port !== undefined) {
		const parsedPort = Number.parseInt(port, 10);
		if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
			return false;
		}
	}

	return true;
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
