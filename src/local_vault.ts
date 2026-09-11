import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type NoteEntry = {
	path: string;
	size: number;
};

export type SearchHit = {
	path: string;
	fragments: string[];
};

export class VaultError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VaultError";
	}
}

export type LocalVaultOptions = {
	allowedPrefixes?: string[];
	deniedPrefixes?: string[];
	gitEnabled?: boolean;
	authorName?: string;
	authorEmail?: string;
};

const NOTE_EXTENSIONS = [".md", ".markdown"];
const DEFAULT_DENIED = [".git", ".obsidian", ".claude"];

export class LocalGitVaultClient {
	private vaultRoot: string;
	private allowedPrefixes: string[];
	private deniedPrefixes: string[];
	private gitEnabled: boolean;
	private authorName: string;
	private authorEmail: string;

	constructor(vaultRoot: string, options: LocalVaultOptions = {}) {
		this.vaultRoot = path.resolve(vaultRoot);
		this.allowedPrefixes = (options.allowedPrefixes || []).map((p) => this.cleanPrefix(p));
		this.deniedPrefixes = (options.deniedPrefixes || DEFAULT_DENIED).map((p) => this.cleanPrefix(p));
		this.gitEnabled = options.gitEnabled !== false;
		this.authorName = options.authorName || "AdminOS Vault";
		this.authorEmail = options.authorEmail || "vault@adminos.local";
	}

	private cleanPrefix(p: string): string {
		return p.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	}

	public normalizePath(relPath: string): string {
		if (!relPath || typeof relPath !== "string") {
			throw new VaultError("Invalid path: Path cannot be empty");
		}
		let trimmed = relPath.trim().replace(/\\/g, "/");
		if (!trimmed) {
			throw new VaultError("Invalid path: Path cannot be empty");
		}
		if (trimmed.includes("\0")) {
			throw new VaultError("Invalid path: Null byte detected");
		}
		if (/^[a-zA-Z]:/.test(trimmed)) {
			throw new VaultError(`Invalid path: Absolute drive path rejected: ${relPath}`);
		}
		trimmed = trimmed.replace(/^\/+/, "");
		if (!trimmed) {
			throw new VaultError("Invalid path: Root directory path rejected");
		}
		const segments = trimmed.split("/");
		if (segments.some((seg) => seg === "..")) {
			throw new VaultError(`Invalid path: Directory traversal detected: ${relPath}`);
		}
		return trimmed;
	}

	public isPathVisible(relPath: string): boolean {
		const clean = relPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		for (const denied of this.deniedPrefixes) {
			if (clean === denied || clean.startsWith(`${denied}/`)) {
				return false;
			}
		}
		if (this.allowedPrefixes.length === 0) {
			return true;
		}
		for (const allowed of this.allowedPrefixes) {
			if (clean === allowed || clean.startsWith(`${allowed}/`)) {
				return true;
			}
		}
		return false;
	}

	private isNote(relPath: string): boolean {
		const lower = relPath.toLowerCase();
		return NOTE_EXTENSIONS.some((ext) => lower.endsWith(ext));
	}

	private async runGit(args: string[]): Promise<string> {
		const env = {
			...process.env,
			GIT_AUTHOR_NAME: this.authorName,
			GIT_AUTHOR_EMAIL: this.authorEmail,
			GIT_COMMITTER_NAME: this.authorName,
			GIT_COMMITTER_EMAIL: this.authorEmail,
		};
		const { stdout } = await execFileAsync("git", args, { cwd: this.vaultRoot, env });
		return stdout.trim();
	}

	private async getHeadCommitSha(): Promise<string | undefined> {
		try {
			let gitDir = path.join(this.vaultRoot, ".git");
			const stat = await fs.stat(gitDir);
			if (stat.isFile()) {
				const content = (await fs.readFile(gitDir, "utf-8")).trim();
				if (content.startsWith("gitdir:")) {
					gitDir = path.resolve(this.vaultRoot, content.slice(7).trim());
				}
			}
			const headFile = path.join(gitDir, "HEAD");
			const headContent = (await fs.readFile(headFile, "utf-8")).trim();
			if (headContent.startsWith("ref:")) {
				const refRel = headContent.slice(4).trim();
				const refFile = path.join(gitDir, refRel);
				try {
					return (await fs.readFile(refFile, "utf-8")).trim();
				} catch {
					const packedFile = path.join(gitDir, "packed-refs");
					try {
						const packed = await fs.readFile(packedFile, "utf-8");
						for (const line of packed.split("\n")) {
							if (line.endsWith(refRel)) {
								return line.split(" ")[0].trim();
							}
						}
					} catch {
						// fallback
					}
				}
			} else if (headContent.length >= 40 && !/[\s/]/.test(headContent)) {
				return headContent;
			}
			return await this.runGit(["rev-parse", "HEAD"]);
		} catch {
			return undefined;
		}
	}

	async listNotes(dir?: string): Promise<{ notes: NoteEntry[]; truncated: boolean }> {
		const dirFilter = dir && dir.trim() ? this.normalizePath(dir) : null;
		const results: NoteEntry[] = [];

		const scanDir = async (currentAbsDir: string) => {
			let entries;
			try {
				entries = await fs.readdir(currentAbsDir, { withFileTypes: true });
			} catch {
				return;
			}

			for (const entry of entries) {
				const fullAbs = path.join(currentAbsDir, entry.name);
				const relPath = path.relative(this.vaultRoot, fullAbs).replace(/\\/g, "/");

				if (entry.isDirectory()) {
					if (this.deniedPrefixes.some((d) => relPath === d || relPath.startsWith(`${d}/`))) {
						continue;
					}
					await scanDir(fullAbs);
				} else if (entry.isFile()) {
					if (!this.isNote(relPath)) continue;
					if (!this.isPathVisible(relPath)) continue;
					if (dirFilter && relPath !== dirFilter && !relPath.startsWith(`${dirFilter}/`)) {
						continue;
					}

					try {
						const stat = await fs.stat(fullAbs);
						results.push({ path: relPath, size: stat.size });
					} catch {
						results.push({ path: relPath, size: 0 });
					}
				}
			}
		};

		await scanDir(this.vaultRoot);
		results.sort((a, b) => a.path.localeCompare(b.path));
		return { notes: results, truncated: false };
	}

	async readNote(relPath: string): Promise<{ path: string; content: string }> {
		const normalized = this.normalizePath(relPath);
		if (!this.isNote(normalized)) {
			throw new VaultError(`Not a note: ${relPath}`);
		}
		if (!this.isPathVisible(normalized)) {
			throw new VaultError(`Path is not accessible: ${relPath}`);
		}

		const fullAbs = path.join(this.vaultRoot, normalized);
		try {
			const content = await fs.readFile(fullAbs, { encoding: "utf-8" });
			return { path: normalized, content };
		} catch (err: any) {
			if (err.code === "ENOENT") {
				throw new VaultError(`Note not found: ${relPath}`);
			}
			throw new VaultError(`Failed to read note ${relPath}: ${err.message}`);
		}
	}

	async writeNote(
		relPath: string,
		content: string,
	): Promise<{ path: string; created: boolean; commitSha?: string }> {
		const normalized = this.normalizePath(relPath);
		if (!this.isNote(normalized)) {
			throw new VaultError(`Not a note (.md/.markdown): ${relPath}`);
		}
		if (!this.isPathVisible(normalized)) {
			throw new VaultError(`Path is not accessible: ${relPath}`);
		}

		const fullAbs = path.join(this.vaultRoot, normalized);
		await fs.mkdir(path.dirname(fullAbs), { recursive: true });

		let created = false;
		try {
			await fs.access(fullAbs);
		} catch {
			created = true;
		}

		await fs.writeFile(fullAbs, content, { encoding: "utf-8" });

		let commitSha: string | undefined;
		if (this.gitEnabled) {
			try {
				const action = created ? "create" : "update";
				if (created) {
					await this.runGit(["add", normalized]);
					await this.runGit(["commit", "-m", `docs(vault): ${action} ${normalized}`]);
				} else {
					await this.runGit(["commit", "-m", `docs(vault): ${action} ${normalized}`, normalized]);
				}
				commitSha = await this.getHeadCommitSha();
			} catch {
				commitSha = undefined;
			}
		}

		return { path: normalized, created, commitSha };
	}

	async deleteNote(relPath: string): Promise<{ path: string; commitSha?: string }> {
		const normalized = this.normalizePath(relPath);
		if (!this.isNote(normalized)) {
			throw new VaultError(`Not a note (.md/.markdown): ${relPath}`);
		}
		if (!this.isPathVisible(normalized)) {
			throw new VaultError(`Path is not accessible: ${relPath}`);
		}

		const fullAbs = path.join(this.vaultRoot, normalized);
		try {
			await fs.unlink(fullAbs);
		} catch (err: any) {
			if (err.code === "ENOENT") {
				throw new VaultError(`Note not found: ${relPath}`);
			}
			throw new VaultError(`Failed to delete note ${relPath}: ${err.message}`);
		}

		let commitSha: string | undefined;
		if (this.gitEnabled) {
			try {
				await this.runGit(["add", normalized]);
				await this.runGit(["commit", "-m", `docs(vault): delete ${normalized}`]);
				commitSha = await this.getHeadCommitSha();
			} catch {
				commitSha = undefined;
			}
		}

		return { path: normalized, commitSha };
	}

	async searchNotes(query: string, limit = 10): Promise<SearchHit[]> {
		if (!query || !query.trim()) return [];
		const needle = query.toLowerCase();
		const maxResults = Math.min(Math.max(1, limit), 100);

		const { notes } = await this.listNotes();
		const hits: SearchHit[] = [];

		for (const note of notes) {
			const fullAbs = path.join(this.vaultRoot, note.path);
			let content = "";
			try {
				content = await fs.readFile(fullAbs, { encoding: "utf-8" });
			} catch {
				continue;
			}

			const pathMatch = note.path.toLowerCase().includes(needle);
			const contentLower = content.toLowerCase();
			const contentMatch = contentLower.includes(needle);

			if (!pathMatch && !contentMatch) continue;

			const fragments: string[] = [];
			if (contentMatch) {
				for (const line of content.split("\n")) {
					if (line.toLowerCase().includes(needle)) {
						const trimmed = line.trim();
						if (trimmed) {
							fragments.push(trimmed);
							if (fragments.length >= 5) break;
						}
					}
				}
			}

			hits.push({ path: note.path, fragments });
			if (hits.length >= maxResults) break;
		}

		return hits;
	}
}
