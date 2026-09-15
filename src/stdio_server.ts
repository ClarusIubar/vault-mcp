import readline from "node:readline";
import process from "node:process";
import { LocalGitVaultClient } from "./local_vault.ts";

const vaultRoot = process.env.VAULT_LOCAL_ROOT || process.cwd();
const vault = new LocalGitVaultClient(vaultRoot, {
	authorName: process.env.GIT_AUTHOR_NAME,
	authorEmail: process.env.GIT_AUTHOR_EMAIL,
});

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	terminal: false,
});

const TOOLS_METADATA = [
	{
		name: "list_notes",
		description: "List note (markdown) paths in the vault. Optionally scope to a subdirectory.",
		inputSchema: {
			type: "object",
			properties: {
				dir: { type: "string", description: "Optional repo-relative directory to scope the listing to." },
			},
		},
	},
	{
		name: "read_note",
		description: "Read the raw markdown of a single note by its repo-relative path.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Repo-relative path to the note." },
			},
			required: ["path"],
		},
	},
	{
		name: "write_note",
		description: "Create a new note or overwrite an existing one at a repo-relative path.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Repo-relative path to the note." },
				content: { type: "string", description: "Full markdown content to write." },
			},
			required: ["path", "content"],
		},
	},
	{
		name: "delete_note",
		description: "Delete an existing note by its repo-relative path.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Repo-relative path to the note to delete." },
			},
			required: ["path"],
		},
	},
	{
		name: "search_notes",
		description: "Search notes by content and filename. Returns matching paths with snippets.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Text to search for across note contents and filenames." },
				limit: { type: "number", description: "Maximum number of notes to return." },
			},
			required: ["query"],
		},
	},
];

rl.on("line", async (raw) => {
	const trimmed = raw.trim();
	if (!trimmed) return;

	let req: any;
	try {
		req = JSON.parse(trimmed);
	} catch {
		return;
	}

	const id = req.id;
	const method = req.method;

	// Handle notification (no id)
	if (id === undefined || id === null) {
		return;
	}

	if (method === "initialize") {
		const resp = {
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2024-11-05",
				serverInfo: {
					name: "vault-mcp",
					version: "0.2.0",
				},
				capabilities: {
					tools: {},
				},
			},
		};
		process.stdout.write(JSON.stringify(resp) + "\n");
		return;
	}

	if (method === "tools/list") {
		const resp = {
			jsonrpc: "2.0",
			id,
			result: {
				tools: TOOLS_METADATA,
			},
		};
		process.stdout.write(JSON.stringify(resp) + "\n");
		return;
	}

	if (method === "tools/call") {
		const name = req.params?.name;
		const args = req.params?.arguments || {};

		try {
			let resultText = "";
			let structuredContent: Record<string, unknown> | undefined = undefined;
			if (name === "list_notes") {
				const { notes, truncated } = await vault.listNotes(args.dir);
				const header = `${notes.length} note(s)${truncated ? " (truncated)" : ""}:`;
				resultText = [header, ...notes.map((n) => n.path)].join("\n");
			} else if (name === "read_note") {
				const note = await vault.readNote(args.path);
				resultText = note.content;
			} else if (name === "write_note") {
				const res = await vault.writeNote(args.path, args.content);
				resultText = `${res.created ? "Created" : "Updated"} ${res.path}`;
				structuredContent = {
					path: res.path,
					created: res.created,
					commitSha: res.commitSha,
				};
			} else if (name === "delete_note") {
				const res = await vault.deleteNote(args.path);
				resultText = `Deleted ${res.path}`;
				structuredContent = {
					path: res.path,
					commitSha: res.commitSha,
				};
			} else if (name === "search_notes") {
				const hits = await vault.searchNotes(args.query, args.limit || 10);
				if (hits.length === 0) {
					resultText = `No notes matched: ${args.query}`;
				} else {
					resultText = hits
						.map((h) => {
							const snip = h.fragments.length > 0 ? `\n${h.fragments.join("\n---\n")}` : "";
							return `## ${h.path}${snip}`;
						})
						.join("\n\n");
				}
			} else {
				const resp = {
					jsonrpc: "2.0",
					id,
					error: {
						code: -32601,
						message: `Unknown tool: ${name}`,
					},
				};
				process.stdout.write(JSON.stringify(resp) + "\n");
				return;
			}

			const resultObj: Record<string, unknown> = {
				content: [{ type: "text", text: resultText }],
			};
			if (structuredContent !== undefined) {
				resultObj.structuredContent = structuredContent;
			}
			const resp = {
				jsonrpc: "2.0",
				id,
				result: resultObj,
			};
			process.stdout.write(JSON.stringify(resp) + "\n");
		} catch (err: any) {
			const resp = {
				jsonrpc: "2.0",
				id,
				result: {
					content: [{ type: "text", text: err.message || String(err) }],
					isError: true,
				},
			};
			process.stdout.write(JSON.stringify(resp) + "\n");
		}
		return;
	}

	// Method not found
	const resp = {
		jsonrpc: "2.0",
		id,
		error: {
			code: -32601,
			message: `Method not found: ${method}`,
		},
	};
	process.stdout.write(JSON.stringify(resp) + "\n");
});
