import { spawn } from "node:child_process";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-tui";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Data, Effect } from "effect";
import { Type } from "typebox";

import { PREVIEW_LINES } from "./constants.ts";
import { openProtonMailHub } from "./protonmail-tui.ts";
import { resolveSecretReference } from "./secret-refs.ts";
import type {
	BridgeStatusResult,
	CommandContext,
	HelperFailure,
	HelperSuccess,
	MailboxListResult,
	MessageListResult,
	ProtonBridgeConfig,
	ToolContext,
} from "./types.ts";

class ProtonCommandError extends Data.TaggedError("ProtonCommandError")<{
	message: string;
}> {}

function toProtonCommandError(error: unknown): ProtonCommandError {
	return new ProtonCommandError({
		message: error instanceof Error ? error.message : String(error),
	});
}

function runProtonBoundary(ctx: CommandContext, effect: Effect.Effect<void, ProtonCommandError>) {
	return Effect.runPromise(
		Effect.catchAll(effect, (error) =>
			Effect.sync(() => {
				ctx.ui.notify(error.message, "error");
			}),
		),
	);
}

function effectFromProtonThunk<T>(thunk: () => T): Effect.Effect<T, ProtonCommandError> {
	return Effect.try({ try: thunk, catch: toProtonCommandError });
}

function effectFromProtonPromise<T>(thunk: () => Promise<T>): Effect.Effect<T, ProtonCommandError> {
	return Effect.tryPromise({ try: thunk, catch: toProtonCommandError });
}

function renderPreview(text: string, expanded: boolean, _theme: Theme) {
	const mdTheme = getMarkdownTheme();
	if (expanded) return new Markdown(text, 0, 0, mdTheme);

	const lines = text.split("\n");
	if (lines.length <= PREVIEW_LINES) return new Markdown(text, 0, 0, mdTheme);
	const preview = lines.slice(0, PREVIEW_LINES).join("\n");
	return new Markdown(`${preview}\n… ${lines.length - PREVIEW_LINES} more lines`, 0, 0, mdTheme);
}

function renderToolResult(
	result: { content?: Array<{ type: string; text?: string }> },
	options: { expanded: boolean },
	theme: Theme,
) {
	const text = result.content?.[0]?.type === "text" ? (result.content[0].text ?? "") : "";
	return renderPreview(text || "(empty)", options.expanded, theme);
}

function trimText(text: string, maxLines = 120, maxChars = 12000): string {
	const lines = text.split("\n");
	let trimmed = lines.slice(0, maxLines).join("\n");
	if (trimmed.length > maxChars) trimmed = `${trimmed.slice(0, maxChars)}\n… output truncated`;
	if (lines.length > maxLines) trimmed += `\n… ${lines.length - maxLines} more lines`;
	return trimmed;
}

function parseMonthPeriod(value?: string): string | undefined {
	if (!value) return undefined;
	return /^\d{4}-\d{2}$/.test(value) ? value : undefined;
}

function protonBridgeSetupHint(): string {
	return [
		"Proton Bridge mail intake is not fully configured.",
		"",
		"Add these variables to .env before starting Pi:",
		"- PROTON_BRIDGE_HOST=127.0.0.1",
		"- PROTON_BRIDGE_IMAP_PORT=1143",
		"- PROTON_BRIDGE_SMTP_PORT=1025",
		"- PROTON_BRIDGE_IMAP_SECURITY=starttls",
		"- PROTON_BRIDGE_USERNAME=<Bridge mailbox username, `op://...`, or literal `op read ...` / `$(op read ...)`>",
		"- PROTON_BRIDGE_PASSWORD=<Bridge mailbox password, `op://...`, or literal `op read ...` / `$(op read ...)`>",
		"- optional: PROTON_BRIDGE_DEFAULT_MAILBOX=<mailbox name such as All Mail>",
		"",
		"Use `/proton-status` to verify the local Bridge ports and `/proton-mailboxes` to discover mailbox names.",
	].join("\n");
}

async function getProtonBridgeConfig(): Promise<ProtonBridgeConfig> {
	const host = process.env.PROTON_BRIDGE_HOST?.trim() || "127.0.0.1";
	const imapPort = Number.parseInt(process.env.PROTON_BRIDGE_IMAP_PORT?.trim() || "1143", 10);
	const smtpPort = Number.parseInt(process.env.PROTON_BRIDGE_SMTP_PORT?.trim() || "1025", 10);
	const security = process.env.PROTON_BRIDGE_IMAP_SECURITY?.trim() || "starttls";
	const defaultMailbox = process.env.PROTON_BRIDGE_DEFAULT_MAILBOX?.trim() || undefined;
	const rawUsername = process.env.PROTON_BRIDGE_USERNAME?.trim() || undefined;
	const rawPassword = process.env.PROTON_BRIDGE_PASSWORD?.trim() || undefined;
	const username = rawUsername
		? await resolveSecretReference(rawUsername, "Proton Bridge username")
		: undefined;
	const password = rawPassword
		? await resolveSecretReference(rawPassword, "Proton Bridge password")
		: undefined;
	return { host, imapPort, smtpPort, username, password, security, defaultMailbox };
}

async function runHelper<T>(
	cwd: string,
	action: string,
	payload: Record<string, unknown>,
): Promise<T> {
	const helperPath = resolve(cwd, ".pi/helpers/proton_bridge.py");
	return new Promise<T>((resolvePromise, reject) => {
		const child = spawn("python3", [helperPath, action], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});
		child.on("error", (error: Error) => reject(error));
		child.on("close", (code: number | null) => {
			if (code !== 0 && !stdout.trim()) {
				reject(new Error(stderr.trim() || `Proton Bridge helper exited with code ${code}`));
				return;
			}

			let parsed: HelperSuccess<T> | HelperFailure;
			try {
				parsed = JSON.parse(stdout) as HelperSuccess<T> | HelperFailure;
			} catch (error) {
				reject(
					new Error(
						`Failed to parse Proton Bridge helper output. ${stderr.trim()} ${error instanceof Error ? error.message : String(error)}`.trim(),
					),
				);
				return;
			}

			if (!parsed.ok) {
				reject(new Error(parsed.error || stderr.trim() || "Proton Bridge helper failed."));
				return;
			}
			resolvePromise(parsed.result);
		});

		child.stdin.end(JSON.stringify(payload));
	});
}

async function protonBridgeStatus(cwd: string): Promise<BridgeStatusResult> {
	const config = await getProtonBridgeConfig();
	return runHelper<BridgeStatusResult>(cwd, "status", {
		config: {
			host: config.host,
			imap_port: config.imapPort,
			smtp_port: config.smtpPort,
			username: config.username,
			password: config.password,
			security: config.security,
			default_mailbox: config.defaultMailbox,
		},
	});
}

async function listProtonMailboxes(cwd: string, query?: string): Promise<MailboxListResult> {
	const config = await getProtonBridgeConfig();
	if (!config.username || !config.password) throw new Error(protonBridgeSetupHint());
	return runHelper<MailboxListResult>(cwd, "list-mailboxes", {
		config: {
			host: config.host,
			imap_port: config.imapPort,
			smtp_port: config.smtpPort,
			username: config.username,
			password: config.password,
			security: config.security,
			default_mailbox: config.defaultMailbox,
		},
		query,
	});
}

async function listProtonMessages(
	cwd: string,
	mailbox?: string,
	period?: string,
	query?: string,
	unseenOnly = false,
	limit = 20,
): Promise<MessageListResult> {
	const config = await getProtonBridgeConfig();
	if (!config.username || !config.password) throw new Error(protonBridgeSetupHint());
	return runHelper<MessageListResult>(cwd, "list-messages", {
		config: {
			host: config.host,
			imap_port: config.imapPort,
			smtp_port: config.smtpPort,
			username: config.username,
			password: config.password,
			security: config.security,
			default_mailbox: config.defaultMailbox,
		},
		mailbox,
		period,
		query,
		unseen_only: unseenOnly,
		limit,
	});
}

function formatStatusSummary(result: BridgeStatusResult): string {
	const lines = [
		"# Proton Bridge Status",
		"",
		`- Host: \`${result.config.host}\``,
		`- IMAP port: \`${result.config.imap_port}\``,
		`- SMTP port: \`${result.config.smtp_port}\``,
		`- IMAP security: \`${result.config.security}\``,
		`- Default mailbox: ${result.config.default_mailbox ? `\`${result.config.default_mailbox}\`` : "—"}`,
		`- Username configured: ${result.config.username_set ? "yes" : "no"}`,
		`- Password configured: ${result.config.password_set ? "yes" : "no"}`,
		"",
		"## Local ports",
		"",
		`- IMAP: ${result.imap.open ? "open" : `closed (${result.imap.error ?? "unknown error"})`}`,
		result.imap.banner
			? `- IMAP banner: \`${result.imap.banner.replace(/`/g, "'")}\``
			: "- IMAP banner: —",
		`- SMTP: ${result.smtp.open ? "open" : `closed (${result.smtp.error ?? "unknown error"})`}`,
	];

	if (result.login) {
		lines.push("", "## Login check", "");
		if (result.login.ok) {
			lines.push(`- Login: ok`, `- Mailboxes visible: ${result.login.mailbox_count ?? 0}`);
			(result.login.mailboxes ?? []).slice(0, 5).forEach((mailbox) => {
				lines.push(`- ${mailbox.name}`);
			});
		} else {
			lines.push(`- Login: failed`, `- Error: ${result.login.error ?? "unknown error"}`);
		}
	}

	if (!result.config.username_set || !result.config.password_set) {
		lines.push("", protonBridgeSetupHint());
	}

	return lines.join("\n");
}

function formatMailboxSummary(result: MailboxListResult, query?: string): string {
	const lines = [
		query ? `# Proton Bridge Mailboxes matching ${query}` : "# Proton Bridge Mailboxes",
		"",
		`- Count: ${result.count}`,
		"",
	];
	result.mailboxes.forEach((mailbox) => {
		const flags = mailbox.flags?.length ? ` (${mailbox.flags.join(", ")})` : "";
		lines.push(`- ${mailbox.name}${flags}`);
	});
	return lines.join("\n");
}

function formatMessageSummary(result: MessageListResult, period?: string): string {
	const lines = [
		`# Proton Bridge Messages — ${result.mailbox}${period ? ` ${period}` : ""}`,
		"",
		`- Matching messages: ${result.count}`,
		"",
		"| UID | Date | From | Subject | Attachments |",
		"|---|---|---|---|---|",
	];

	result.messages.forEach((message) => {
		const attachments =
			message.attachments.length > 0
				? message.attachments
						.map((attachment) => attachment.filename.replace(/\|/g, " "))
						.join(", ")
				: "—";
		lines.push(
			`| ${message.uid} | ${(message.date ?? "—").replace(/\|/g, " ")} | ${(message.from ?? "—").replace(/\|/g, " ")} | ${(message.subject ?? "—").replace(/\|/g, " ")} | ${attachments} |`,
		);
	});

	if (result.messages.length === 0) lines.push("| — | — | — | — | — |");
	return lines.join("\n");
}

function sendReport(pi: ExtensionAPI, title: string, body: string) {
	pi.sendMessage({
		customType: "protonmail-report",
		content: `${title}\n\n${body}`,
		display: true,
	});
}

function parseMessagesCommandArgs(raw: string): { mailbox?: string; period?: string } {
	const parts = raw.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return {};
	const last = parts.at(-1);
	const period = last && parseMonthPeriod(last) ? last : undefined;
	const mailboxParts = period ? parts.slice(0, -1) : parts;
	const mailbox = mailboxParts.join(" ").trim() || undefined;
	return { mailbox, period };
}

export default function registerProtonBridgeExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer(
		"protonmail-report",
		(message: { content: string }, { expanded }: { expanded: boolean }, theme: Theme) =>
			renderPreview(message.content, expanded, theme),
	);

	pi.registerCommand("proton-status", {
		description: "Check Proton Bridge connectivity and local configuration",
		handler: async (_args: string, ctx: CommandContext) =>
			runProtonBoundary(
				ctx,
				Effect.gen(function* () {
					const result = yield* effectFromProtonPromise(() => protonBridgeStatus(ctx.cwd));
					yield* Effect.sync(() => {
						sendReport(pi, "Proton Bridge status", formatStatusSummary(result));
					});
				}),
			),
	});

	pi.registerCommand("proton-mailboxes", {
		description: "List mailboxes visible through Proton Bridge IMAP",
		handler: async (args: string, ctx: CommandContext) =>
			runProtonBoundary(
				ctx,
				Effect.gen(function* () {
					const query = args.trim() || undefined;
					const result = yield* effectFromProtonPromise(() => listProtonMailboxes(ctx.cwd, query));
					yield* Effect.sync(() => {
						sendReport(
							pi,
							query ? `Proton mailboxes matching ${query}` : "Proton mailboxes",
							formatMailboxSummary(result, query),
						);
					});
				}),
			),
	});

	pi.registerCommand("proton-messages", {
		description: "Preview attachment-bearing Proton Bridge messages for a mailbox/month",
		handler: async (args: string, ctx: CommandContext) =>
			runProtonBoundary(
				ctx,
				Effect.gen(function* () {
					const parsed = yield* effectFromProtonThunk(() => parseMessagesCommandArgs(args));
					const result = yield* effectFromProtonPromise(() =>
						listProtonMessages(ctx.cwd, parsed.mailbox, parsed.period, undefined, false, 20),
					);
					yield* Effect.sync(() => {
						sendReport(
							pi,
							`Proton messages ${result.mailbox}${parsed.period ? ` ${parsed.period}` : ""}`,
							formatMessageSummary(result, parsed.period),
						);
					});
				}),
			),
	});

	pi.registerCommand("protonmail", {
		description: "Open an interactive Proton Mail TUI",
		handler: async (args: string, ctx: CommandContext) =>
			runProtonBoundary(
				ctx,
				Effect.gen(function* () {
					yield* effectFromProtonPromise(() =>
						openProtonMailHub(
							ctx,
							{
								status: protonBridgeStatus,
								mailboxes: listProtonMailboxes,
								messages: (cwd, mailbox, period) =>
									listProtonMessages(cwd, mailbox, period, undefined, false, 50),
							},
							args,
						),
					);
				}),
			),
	});

	pi.registerTool({
		name: "protonmail_bridge_status",
		label: "ProtonMail Bridge Status",
		description: "Check Proton Bridge host/ports, credential presence, and IMAP login health",
		promptSnippet: "Check whether Proton Bridge is reachable and configured before reading mail",
		promptGuidelines: [
			"Use this tool before listing mailboxes or importing attachments from Proton Bridge.",
			"Bridge exposes local IMAP/SMTP ports; this tool verifies the repo-side config and whether login succeeds.",
		],
		parameters: Type.Object({}),
		async execute(
			_id: string,
			_params: Record<string, never>,
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ToolContext,
		) {
			const result = await protonBridgeStatus(ctx.cwd);
			return {
				content: [{ type: "text", text: trimText(formatStatusSummary(result), 160, 16000) }],
				details: result,
			};
		},
		renderCall(_args: Record<string, never>, theme: Theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("protonmail_bridge_status"))}`, 0, 0);
		},
		renderResult: renderToolResult,
	});

	pi.registerTool({
		name: "protonmail_list_mailboxes",
		label: "ProtonMail List Mailboxes",
		description: "List Proton Bridge mailboxes available through local IMAP",
		promptSnippet: "List Proton Bridge mailboxes before choosing one for import",
		promptGuidelines: [
			"Use this tool after protonmail_bridge_status when you need the exact mailbox name for import.",
			"Mailbox names come from Proton Bridge IMAP and may differ from UI labels if the account language changes.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Optional mailbox substring filter" })),
		}),
		async execute(
			_id: string,
			params: { query?: string },
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ToolContext,
		) {
			const result = await listProtonMailboxes(ctx.cwd, params.query);
			return {
				content: [
					{ type: "text", text: trimText(formatMailboxSummary(result, params.query), 160, 16000) },
				],
				details: result,
			};
		},
		renderCall(args: { query?: string }, theme: Theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("protonmail_list_mailboxes "))}${theme.fg("dim", args.query ?? "all")}`,
				0,
				0,
			);
		},
		renderResult: renderToolResult,
	});

	pi.registerTool({
		name: "protonmail_list_messages",
		label: "ProtonMail List Messages",
		description: "List recent attachment-bearing messages from a Proton Bridge mailbox",
		promptSnippet: "Preview Proton Bridge messages before importing expense attachments",
		promptGuidelines: [
			"Pass an explicit mailbox or set PROTON_BRIDGE_DEFAULT_MAILBOX.",
			"Use period to narrow the scan to one month such as 2026-04 when importing spendings.",
		],
		parameters: Type.Object({
			mailbox: Type.Optional(
				Type.String({
					description: "Mailbox name; defaults to PROTON_BRIDGE_DEFAULT_MAILBOX if set",
				}),
			),
			period: Type.Optional(Type.String({ description: "Optional month filter such as 2026-04" })),
			query: Type.Optional(
				Type.String({ description: "Optional subject/from/attachment substring filter" }),
			),
			unseenOnly: Type.Optional(Type.Boolean({ description: "If true, limit to unseen messages" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of messages to return" })),
		}),
		async execute(
			_id: string,
			params: {
				mailbox?: string;
				period?: string;
				query?: string;
				unseenOnly?: boolean;
				limit?: number;
			},
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ToolContext,
		) {
			const period = params.period ? parseMonthPeriod(params.period) : undefined;
			if (params.period && !period)
				throw new Error(`Invalid period \`${params.period}\`. Expected YYYY-MM.`);
			const result = await listProtonMessages(
				ctx.cwd,
				params.mailbox,
				period,
				params.query,
				params.unseenOnly ?? false,
				params.limit ?? 20,
			);
			return {
				content: [
					{ type: "text", text: trimText(formatMessageSummary(result, period), 160, 16000) },
				],
				details: result,
			};
		},
		renderCall(args: { mailbox?: string; period?: string }, theme: Theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("protonmail_list_messages "))}${theme.fg("dim", `${args.mailbox ?? "default mailbox"}${args.period ? ` ${args.period}` : ""}`)}`,
				0,
				0,
			);
		},
		renderResult: renderToolResult,
	});
}
