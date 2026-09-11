type Props = { login?: string };

function parseList(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function isLoginAllowed(login: string | undefined, allowedLogins: string[]): boolean {
	return login !== undefined && allowedLogins.includes(login);
}

/** A minimal fetch handler: the gate's own shape and the inner one it wraps. */
type ApiHandler = {
	fetch(request: any, env: any, ctx: any): any;
};

/**
 * Wraps an API handler with the login allowlist gate. OAuthProvider sets
 * `ctx.props` before this runs, so a login absent from
 * `VAULT_ALLOWED_GITHUB_LOGINS` is rejected before the wrapped handler (and the
 * VaultMCP Durable Object it creates) is ever reached. Only the allowlist is
 * read here; the rest of the env is validated a step later during DO init.
 */
export function createGuardedApiHandler(inner: ApiHandler): ApiHandler {
	return {
		fetch: (req, env, ctx) => {
			const login = (ctx as any).props?.login;
			if (!isLoginAllowed(login, parseList(env.VAULT_ALLOWED_GITHUB_LOGINS))) {
				return Promise.resolve(new Response("Forbidden", { status: 403 }));
			}
			return inner.fetch(req, env, ctx);
		},
	};
}

// ── MCP Tool Parameter Validation Gate ────────────────────────────────────────

const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;
const WINDOWS_DRIVE_REGEX = /^[a-zA-Z]:/;

export function validateVaultPath(raw: unknown): string {
	if (typeof raw !== "string") {
		throw new Error("Path must be a string");
	}
	const clean = raw.trim();
	if (!clean) {
		throw new Error("Path cannot be empty");
	}
	if (CONTROL_CHAR_REGEX.test(clean)) {
		throw new Error("Path contains illegal control characters");
	}
	if (clean.startsWith("/") || clean.startsWith("\\") || WINDOWS_DRIVE_REGEX.test(clean)) {
		throw new Error(`Absolute path '${clean}' is forbidden. Path must be relative to vault root`);
	}
	if (clean.includes("..")) {
		throw new Error(`Path traversal detected in '${clean}'`);
	}
	const parts = clean.replace(/\\/g, "/").split("/");
	for (const p of parts) {
		if (p === "." || p === "..") {
			throw new Error(`Path traversal detected in '${clean}'`);
		}
	}
	if (!clean.toLowerCase().endsWith(".md")) {
		throw new Error(`Invalid file extension in '${clean}'. Only markdown (.md) files are permitted`);
	}
	return clean;
}

export function validateToolParams(tool: string, args: Record<string, unknown>): { success: boolean; data?: any; error?: string } {
	try {
		switch (tool) {
			case "list_notes": {
				const dir = args.dir;
				if (dir !== undefined && dir !== null) {
					if (typeof dir !== "string") {
						return { success: false, error: "dir must be a string" };
					}
					const cleanDir = dir.trim();
					if (cleanDir) {
						if (cleanDir.startsWith("/") || cleanDir.startsWith("\\") || WINDOWS_DRIVE_REGEX.test(cleanDir)) {
							return { success: false, error: "Directory path must be relative" };
						}
						if (cleanDir.includes("..")) {
							return { success: false, error: "Directory path traversal detected" };
						}
					}
				}
				return { success: true, data: { dir: args.dir } };
			}
			case "read_note": {
				if (!args.path) {
					return { success: false, error: "Missing required parameter: 'path'" };
				}
				const validPath = validateVaultPath(args.path);
				return { success: true, data: { path: validPath } };
			}
			case "write_note": {
				if (!args.path) {
					return { success: false, error: "Missing required parameter: 'path'" };
				}
				if (args.content === undefined || args.content === null) {
					return { success: false, error: "Missing required parameter: 'content'" };
				}
				if (typeof args.content !== "string") {
					return { success: false, error: "content must be a string" };
				}
				const validPath = validateVaultPath(args.path);
				const MAX_BYTES = 10 * 1024 * 1024;
				if (args.content.length > MAX_BYTES) {
					return { success: false, error: `Content exceeds ${MAX_BYTES} bytes limit` };
				}
				return { success: true, data: { path: validPath, content: args.content } };
			}
			case "delete_note": {
				if (!args.path) {
					return { success: false, error: "Missing required parameter: 'path'" };
				}
				const validPath = validateVaultPath(args.path);
				return { success: true, data: { path: validPath } };
			}
			case "search_notes": {
				if (!args.query || typeof args.query !== "string" || !args.query.trim()) {
					return { success: false, error: "Search query cannot be empty" };
				}
				const limit = args.limit !== undefined ? Number(args.limit) : 20;
				if (Number.isNaN(limit) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
					return { success: false, error: `Search limit must be an integer between 1 and 100, got ${args.limit}` };
				}
				return { success: true, data: { query: args.query.trim(), limit } };
			}
			default:
				return { success: false, error: `Unknown tool '${tool}'` };
		}
	} catch (err: any) {
		return { success: false, error: err.message || String(err) };
	}
}

