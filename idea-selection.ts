import * as http from "node:http";
import * as path from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_PORT = 17373;
const MAX_BODY_BYTES = 10_000;
const INSTANCE_ID = String(process.pid);
const STARTED_AT = Date.now();

function getPiAgentDir(): string {
	const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
	return path.join(home, ".pi", "agent");
}

const REGISTRY_DIR = path.join(getPiAgentDir(), "idea-selection");
const INSTANCES_DIR = path.join(REGISTRY_DIR, "instances");
const INSTANCE_FILE = path.join(INSTANCES_DIR, `${INSTANCE_ID}.json`);
const ACTIVE_TARGETS_FILE = path.join(REGISTRY_DIR, "active-targets.json");

type InstanceInfo = {
	instanceId: string;
	pid: number;
	port: number;
	cwd: string;
	cwdKey: string;
	startedAt: number;
	updatedAt: number;
};

type ActiveTargetsFile = {
	version: 1;
	targets: Record<
		string,
		{
			instanceId: string;
			cwd: string;
			port: number;
			updatedAt: number;
		}
	>;
};

function getPort(): number {
	const raw = process.env.PI_IDEA_SELECTION_PORT;
	const port = raw ? Number(raw) : DEFAULT_PORT;
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

function normalizePathKey(input: string): string {
	let normalized = path.resolve(input).replace(/\\/g, "/");
	while (normalized.length > 1 && normalized.endsWith("/") && !/^[A-Za-z]:\/$/.test(normalized)) {
		normalized = normalized.slice(0, -1);
	}
	return normalized.toLowerCase();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function send(res: http.ServerResponse, statusCode: number, text: string) {
	res.statusCode = statusCode;
	res.setHeader("content-type", "text/plain; charset=utf-8");
	res.end(text);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
	await rename(tempPath, filePath);
}

async function removeFile(filePath: string): Promise<void> {
	try {
		await unlink(filePath);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

async function readActiveTargets(): Promise<ActiveTargetsFile> {
	try {
		const raw = await readFile(ACTIVE_TARGETS_FILE, "utf8");
		const parsed = JSON.parse(raw) as Partial<ActiveTargetsFile>;
		return {
			version: 1,
			targets: parsed.targets && typeof parsed.targets === "object" ? parsed.targets : {},
		};
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { version: 1, targets: {} };
		throw error;
	}
}

function closeServer(server: http.Server | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (!server || !server.listening) {
			resolve();
			return;
		}
		server.close(() => resolve());
	});
}

function listenOnce(server: http.Server, requestedPort: number): Promise<number> {
	return new Promise((resolve, reject) => {
		function cleanup() {
			server.off("error", onError);
			server.off("listening", onListening);
		}

		function onError(error: Error) {
			cleanup();
			reject(error);
		}

		function onListening() {
			cleanup();
			const address = server.address();
			if (address && typeof address === "object") {
				resolve((address as AddressInfo).port);
				return;
			}
			reject(new Error("IDEA selection listener did not expose a TCP port"));
		}

		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(requestedPort, "127.0.0.1");
	});
}

async function startServer(
	createServer: () => http.Server,
	preferredPort: number,
): Promise<{ server: http.Server; port: number; preferredPortUnavailable: boolean }> {
	let server = createServer();
	try {
		const port = await listenOnce(server, preferredPort);
		return { server, port, preferredPortUnavailable: false };
	} catch (error) {
		if (errorCode(error) !== "EADDRINUSE") throw error;
	}

	await closeServer(server);
	server = createServer();
	const port = await listenOnce(server, 0);
	return { server, port, preferredPortUnavailable: true };
}

function createIdeaSelectionServer(pasteToPiEditor: (text: string) => boolean): http.Server {
	return http.createServer((req, res) => {
		const requestPath = req.url?.split("?")[0];

		if (req.method === "GET" && requestPath === "/health") {
			send(res, 200, "ok");
			return;
		}

		if (req.method !== "POST" || requestPath !== "/idea-selection") {
			send(res, 404, "not found");
			return;
		}

		const chunks: Buffer[] = [];
		let size = 0;
		let tooLarge = false;

		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				tooLarge = true;
				return;
			}
			chunks.push(chunk);
		});

		req.on("end", () => {
			if (tooLarge) {
				send(res, 413, "payload too large");
				return;
			}

			try {
				const body = Buffer.concat(chunks).toString("utf8");
				const payload = JSON.parse(body) as { text?: unknown };
				const text = typeof payload.text === "string" ? payload.text : "";

				if (!text.trim()) {
					send(res, 400, "missing text");
					return;
				}

				if (!pasteToPiEditor(text)) {
					send(res, 503, "pi editor is not ready");
					return;
				}

				send(res, 200, "ok");
			} catch (error) {
				send(res, 400, errorMessage(error));
			}
		});
	});
}

export default async function ideaSelectionExtension(pi: ExtensionAPI) {
	let latestCtx: ExtensionContext | undefined;
	let server: http.Server | undefined;
	let serverError: Error | undefined;
	const preferredPort = getPort();
	let port = preferredPort;
	let preferredPortUnavailable = false;

	function pasteToPiEditor(text: string): boolean {
		const ctx = latestCtx;
		const line = text.trim();
		if (!ctx || !line) return false;

		const ui = ctx.ui as unknown as {
			getEditorText?: () => string;
			pasteToEditor: (text: string) => void;
		};
		const current = ui.getEditorText?.() ?? "";
		const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
		ui.pasteToEditor(`${prefix}${line}\n`);

		// pasteToEditor mutates the editor state, but when it is called from this
		// HTTP callback (outside Pi's normal keyboard input loop) the TUI may not
		// repaint until the next keypress. Toggle a short-lived footer status to
		// force an immediate render; clearing a missing status can be optimized
		// away visually on some terminals.
		const refreshStatusKey = "idea-selection-refresh";
		ctx.ui.setStatus(refreshStatusKey, ctx.ui.theme.fg("dim", "IDEA"));
		const timer = setTimeout(() => {
			if (latestCtx === ctx) {
				ctx.ui.setStatus(refreshStatusKey, undefined);
			}
		}, 150);
		if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
			timer.unref();
		}
		return true;
	}

	async function publishInstance(ctx: ExtensionContext): Promise<InstanceInfo | undefined> {
		if (serverError || !server?.listening) return undefined;

		const cwd = path.resolve(ctx.cwd);
		const instance: InstanceInfo = {
			instanceId: INSTANCE_ID,
			pid: process.pid,
			port,
			cwd,
			cwdKey: normalizePathKey(cwd),
			startedAt: STARTED_AT,
			updatedAt: Date.now(),
		};

		await writeJsonAtomic(INSTANCE_FILE, instance);
		return instance;
	}

	async function setActiveTarget(ctx: ExtensionContext): Promise<InstanceInfo | undefined> {
		const instance = await publishInstance(ctx);
		if (!instance) return undefined;

		const activeTargets = await readActiveTargets();
		activeTargets.targets[instance.cwdKey] = {
			instanceId: instance.instanceId,
			cwd: instance.cwd,
			port: instance.port,
			updatedAt: Date.now(),
		};
		await writeJsonAtomic(ACTIVE_TARGETS_FILE, activeTargets);
		return instance;
	}

	try {
		const started = await startServer(() => createIdeaSelectionServer(pasteToPiEditor), preferredPort);
		server = started.server;
		port = started.port;
		preferredPortUnavailable = started.preferredPortUnavailable;
		server.on("error", (error) => {
			serverError = error instanceof Error ? error : new Error(String(error));
			void removeFile(INSTANCE_FILE).catch(() => undefined);
			latestCtx?.ui.notify(`IDEA selection listener failed: ${serverError.message}`, "error");
		});
	} catch (error) {
		serverError = error instanceof Error ? error : new Error(String(error));
	}

	pi.registerCommand("idea-target", {
		description: "Mark this Pi as the active IDEA selection target for the current project",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			const instance = await setActiveTarget(ctx);
			if (!instance) {
				ctx.ui.notify(
					`IDEA selection target was not set: ${serverError ? serverError.message : "listener is not ready"}`,
					"error",
				);
				return;
			}

			ctx.ui.notify(
				`IDEA selection target set for ${instance.cwd} on http://127.0.0.1:${instance.port}/idea-selection`,
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		if (serverError) {
			ctx.ui.notify(`IDEA selection listener failed: ${serverError.message}`, "error");
			return;
		}

		try {
			await publishInstance(ctx);
		} catch (error) {
			ctx.ui.notify(`IDEA selection registry update failed: ${errorMessage(error)}`, "error");
		}

		const suffix = preferredPortUnavailable ? ` (preferred port ${preferredPort} was busy)` : "";
		ctx.ui.notify(`IDEA selection listener: http://127.0.0.1:${port}/idea-selection${suffix}`, "info");
	});

	pi.on("session_shutdown", async () => {
		latestCtx = undefined;
		await removeFile(INSTANCE_FILE);
		await closeServer(server);
	});
}
