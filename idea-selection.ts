import * as http from "node:http";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_PORT = 17373;
const MAX_BODY_BYTES = 10_000;

function getPort(): number {
	const raw = process.env.PI_IDEA_SELECTION_PORT;
	const port = raw ? Number(raw) : DEFAULT_PORT;
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

function send(res: http.ServerResponse, statusCode: number, text: string) {
	res.statusCode = statusCode;
	res.setHeader("content-type", "text/plain; charset=utf-8");
	res.end(text);
}

export default function ideaSelectionExtension(pi: ExtensionAPI) {
	let latestCtx: ExtensionContext | undefined;
	let serverError: Error | undefined;
	const port = getPort();

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
		// repaint until the next keypress. setStatus(undefined) is a no-op status
		// update that still asks Pi's interactive UI to render immediately.
		ctx.ui.setStatus("idea-selection-refresh", undefined);
		return true;
	}

	const server = http.createServer((req, res) => {
		const path = req.url?.split("?")[0];

		if (req.method === "GET" && path === "/health") {
			send(res, 200, "ok");
			return;
		}

		if (req.method !== "POST" || path !== "/idea-selection") {
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
				send(res, 400, error instanceof Error ? error.message : String(error));
			}
		});
	});

	server.on("error", (error) => {
		serverError = error instanceof Error ? error : new Error(String(error));
		latestCtx?.ui.notify(`IDEA selection listener failed: ${serverError.message}`, "error");
	});

	server.listen(port, "127.0.0.1");

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		if (serverError) {
			ctx.ui.notify(`IDEA selection listener failed: ${serverError.message}`, "error");
		} else {
			ctx.ui.notify(`IDEA selection listener: http://127.0.0.1:${port}/idea-selection`, "info");
		}
	});

	pi.on("session_shutdown", async () => {
		latestCtx = undefined;
		await new Promise<void>((resolve) => {
			if (!server.listening) {
				resolve();
				return;
			}
			server.close(() => resolve());
		});
	});
}
