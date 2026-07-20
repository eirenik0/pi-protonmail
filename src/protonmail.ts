import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-tui";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Data, Effect } from "effect";
import { Type } from "typebox";

import { PREVIEW_LINES } from "./constants.ts";
import { openProtonMailHub } from "./hub.ts";
import {
	protonBridgeApplyLabels as runProtonBridgeApplyLabels,
	protonBridgeCopyMessage as runProtonBridgeCopyMessage,
	protonBridgeCreateDraft as runProtonBridgeCreateDraft,
	protonBridgeGetMessage as runProtonBridgeGetMessage,
	protonBridgeImportAttachments as runProtonBridgeImportAttachments,
	protonBridgeListMailboxes as runProtonBridgeListMailboxes,
	protonBridgeListMessages as runProtonBridgeListMessages,
	protonBridgeMoveMessage as runProtonBridgeMoveMessage,
	protonBridgeSendMessage as runProtonBridgeSendMessage,
	protonBridgeStatus as runProtonBridgeStatus,
} from "./proton-bridge.ts";
import { resolveSecretReference } from "./secret-refs.ts";
import type {
	ApplyLabelsResult,
	BridgeStatusResult,
	CommandContext,
	CopyMessageResult,
	CreateDraftResult,
	GetMessageResult,
	MailboxListResult,
	MessageListResult,
	MoveMessageResult,
	ProtonBridgeConfig,
	ProtonMailWorkingProfile,
	SendMessageResult,
	ToolContext,
} from "./types.ts";
import {
	deleteProtonMailProfile,
	listProtonMailProfiles,
	normalizeProtonMailProfile,
	protonMailProfilePolicyPath,
	readProtonMailProfilePolicy,
	readProtonMailWorkspaceConfig,
	writeProtonMailProfilePolicy,
	writeProtonMailWorkspaceConfig,
} from "./workspace.ts";

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

async function getProtonBridgeConfig(defaultMailbox?: string): Promise<ProtonBridgeConfig> {
	const host = process.env.PROTON_BRIDGE_HOST?.trim() || "127.0.0.1";
	const imapPort = Number.parseInt(process.env.PROTON_BRIDGE_IMAP_PORT?.trim() || "1143", 10);
	const smtpPort = Number.parseInt(process.env.PROTON_BRIDGE_SMTP_PORT?.trim() || "1025", 10);
	const security = process.env.PROTON_BRIDGE_IMAP_SECURITY?.trim() || "starttls";
	const envDefaultMailbox = process.env.PROTON_BRIDGE_DEFAULT_MAILBOX?.trim() || undefined;
	const rawUsername = process.env.PROTON_BRIDGE_USERNAME?.trim() || undefined;
	const rawPassword = process.env.PROTON_BRIDGE_PASSWORD?.trim() || undefined;
	const username = rawUsername
		? await resolveSecretReference(rawUsername, "Proton Bridge username")
		: undefined;
	const password = rawPassword
		? await resolveSecretReference(rawPassword, "Proton Bridge password")
		: undefined;
	return {
		host,
		imapPort,
		smtpPort,
		username,
		password,
		security,
		defaultMailbox: defaultMailbox ?? envDefaultMailbox,
	};
}

function protonMailSetupHint(profile?: string): string {
	const profileHint = profile ? ` for profile \`${profile}\`` : "";
	return [
		`Proton Mail setup${profileHint} is not fully configured.`,
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
		"Use `/protonmail` to edit profile defaults and the `protonmail_*` tools to inspect Bridge status, mailboxes, and message imports.",
	].join("\n");
}

function resolveProtonMailImportWorkspaceRoot(profile: string, policyRoot?: string): string {
	return policyRoot?.trim() || join(".pi", "protonmail", "imports", profile);
}

async function listProtonMailWorkingProfiles(cwd: string): Promise<ProtonMailWorkingProfile[]> {
	const profiles = new Map<string, ProtonMailWorkingProfile>();
	for (const profile of await listProtonMailProfiles(cwd)) {
		profiles.set(profile, {
			profile,
			policy: await readProtonMailProfilePolicy(cwd, profile),
			policyPath: protonMailProfilePolicyPath(profile, cwd),
		});
	}

	const defaultProfile = normalizeProtonMailProfile("default");
	if (!profiles.has(defaultProfile)) {
		profiles.set(defaultProfile, {
			profile: defaultProfile,
			policy: await readProtonMailProfilePolicy(cwd, defaultProfile),
			policyPath: protonMailProfilePolicyPath(defaultProfile, cwd),
		});
	}

	return [...profiles.values()].sort((left, right) => left.profile.localeCompare(right.profile));
}

async function resolveProtonMailActiveProfile(
	cwd: string,
	explicitProfile?: string,
): Promise<ProtonMailWorkingProfile> {
	const profiles = await listProtonMailWorkingProfiles(cwd);
	const normalizedExplicit = explicitProfile?.trim()
		? normalizeProtonMailProfile(explicitProfile)
		: undefined;
	if (normalizedExplicit) {
		const explicit = profiles.find((profile) => profile.profile === normalizedExplicit);
		if (explicit) return explicit;
		return {
			profile: normalizedExplicit,
			policy: await readProtonMailProfilePolicy(cwd, normalizedExplicit),
			policyPath: protonMailProfilePolicyPath(normalizedExplicit, cwd),
		};
	}

	const workspace = await readProtonMailWorkspaceConfig(cwd);
	const activeProfile = normalizeProtonMailProfile(workspace.activeProfile);
	return profiles.find((profile) => profile.profile === activeProfile) ?? profiles[0];
}

async function protonBridgeStatus(
	_cwd: string,
	defaultMailbox?: string,
): Promise<BridgeStatusResult> {
	const config = await getProtonBridgeConfig(defaultMailbox);
	return runProtonBridgeStatus(config);
}

async function listProtonMailboxes(
	_cwd: string,
	query?: string,
	defaultMailbox?: string,
): Promise<MailboxListResult> {
	const config = await getProtonBridgeConfig(defaultMailbox);
	if (!config.username || !config.password) throw new Error(protonMailSetupHint(defaultMailbox));
	return runProtonBridgeListMailboxes(config, query);
}

async function listProtonMessages(
	_cwd: string,
	mailbox?: string,
	period?: string,
	query?: string,
	unseenOnly = false,
	limit = 20,
	defaultMailbox?: string,
	attachmentsOnly = false,
	searchFields?: string[],
): Promise<MessageListResult> {
	const config = await getProtonBridgeConfig(defaultMailbox);
	if (!config.username || !config.password) throw new Error(protonMailSetupHint(defaultMailbox));
	return runProtonBridgeListMessages(
		config,
		mailbox,
		period,
		query,
		unseenOnly,
		limit,
		attachmentsOnly,
		searchFields,
	);
}

async function getProtonMessage(
	_cwd: string,
	mailbox: string,
	uid: string,
	includeBody = true,
	includeHeaders = true,
	defaultMailbox?: string,
): Promise<GetMessageResult> {
	const config = await getProtonBridgeConfig(defaultMailbox);
	if (!config.username || !config.password) throw new Error(protonMailSetupHint(defaultMailbox));
	return runProtonBridgeGetMessage(config, { mailbox, uid, includeBody, includeHeaders });
}

function resolveOutgoingFrom(from: string | undefined, profile: ProtonMailWorkingProfile): string {
	const resolved = from?.trim() || profile.policy.default_from?.trim();
	if (!resolved)
		throw new Error("No from address provided and the active profile has no default_from.");
	return resolved;
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
		lines.push("", protonMailSetupHint());
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

function formatGetMessageSummary(result: GetMessageResult): string {
	const lines = [
		`# Proton Bridge Message — ${result.mailbox} UID ${result.uid}`,
		"",
		`- Message ID: ${result.message_id ? `\`${result.message_id}\`` : "—"}`,
		`- Date: ${result.date ?? "—"}`,
		`- From: ${result.from ?? "—"}`,
		`- To: ${result.to ?? "—"}`,
		`- Subject: ${result.subject ?? "—"}`,
		`- Attachments: ${result.attachment_count}`,
	];
	if (result.cc) lines.push(`- Cc: ${result.cc}`);
	if (result.bcc) lines.push(`- Bcc: ${result.bcc}`);
	if (result.attachments.length) {
		lines.push("", "## Attachments", "");
		for (const attachment of result.attachments) {
			lines.push(
				`- ${attachment.filename} (${attachment.size ?? 0} B, ${attachment.content_type ?? "application/octet-stream"})`,
			);
		}
	}
	if (result.text_body) lines.push("", "## Text body", "", result.text_body);
	if (result.html_body) lines.push("", "## HTML body", "", result.html_body);
	if (result.headers?.length) {
		lines.push("", "## Headers", "");
		for (const header of result.headers) lines.push(`- ${header.name}: ${header.value}`);
	}
	return lines.join("\n");
}

function formatCreateDraftSummary(result: CreateDraftResult): string {
	const lines = [
		"# Proton Mail draft created",
		"",
		`- Mailbox: \`${result.mailbox}\``,
		`- UID: ${result.uid ? `\`${result.uid}\`` : "—"}`,
		`- From: ${result.from}`,
		`- To: ${result.to.join(", ")}`,
		`- Subject: ${result.subject}`,
		`- Attachments: ${result.attachment_count}`,
	];
	if (result.cc?.length) lines.push(`- Cc: ${result.cc.join(", ")}`);
	if (result.bcc?.length) lines.push(`- Bcc: ${result.bcc.join(", ")}`);
	return lines.join("\n");
}

function formatSendSummary(result: SendMessageResult): string {
	const lines = [
		"# Proton Mail message sent",
		"",
		`- Message ID: ${result.message_id ? `\`${result.message_id}\`` : "—"}`,
		`- From: ${result.from}`,
		`- To: ${result.to.join(", ")}`,
		`- Subject: ${result.subject}`,
		`- Attachments: ${result.attachment_count}`,
	];
	if (result.cc?.length) lines.push(`- Cc: ${result.cc.join(", ")}`);
	if (result.bcc?.length) lines.push(`- Bcc: ${result.bcc.join(", ")}`);
	if (result.saved_to_mailbox)
		lines.push(
			`- Saved copy: \`${result.saved_to_mailbox}\`${result.saved_uid ? ` UID ${result.saved_uid}` : ""}`,
		);
	if (result.labels?.length)
		lines.push(`- Labels: ${result.labels.map((label) => `\`${label}\``).join(", ")}`);
	if (result.label_mailboxes?.length)
		lines.push(
			`- Label mailboxes: ${result.label_mailboxes.map((label) => `\`${label}\``).join(", ")}`,
		);
	return lines.join("\n");
}

function formatMoveSummary(result: MoveMessageResult): string {
	return [
		"# Proton Mail message moved",
		"",
		`- UID: \`${result.uid}\``,
		`- Source: \`${result.source}\``,
		`- Destination: \`${result.destination}\``,
	].join("\n");
}

function formatCopySummary(result: CopyMessageResult): string {
	return [
		"# Proton Mail message copied",
		"",
		`- Source UID: \`${result.uid}\``,
		`- Copied UID: ${result.copied_uid ? `\`${result.copied_uid}\`` : "—"}`,
		`- Source: \`${result.source}\``,
		`- Destination: \`${result.destination}\``,
	].join("\n");
}

function formatApplyLabelsSummary(result: ApplyLabelsResult): string {
	return [
		"# Proton Mail labels applied",
		"",
		`- UID: \`${result.uid}\``,
		`- Mailbox: \`${result.mailbox}\``,
		`- Labels: ${result.labels.map((label) => `\`${label}\``).join(", ")}`,
		`- Label mailboxes: ${result.label_mailboxes.map((label) => `\`${label}\``).join(", ")}`,
	].join("\n");
}

function formatImportSummary(
	result: {
		workspace_root: string;
		period_root: string;
		mail_root: string;
		inbox_root: string;
		mailbox: string;
		profile: string;
		message_count: number;
		attachment_count: number;
		messages: Array<{
			uid: string;
			subject?: string;
			from?: string;
			date?: string;
			raw_path: string;
			attachment_count: number;
			attachments: Array<{
				filename: string;
				mail_path: string;
				inbox_path: string;
				content_type?: string;
				size?: number;
			}>;
		}>;
	},
	period: string,
): string {
	const lines = [
		`# Proton Mail import — ${result.profile} ${period}`,
		"",
		`- Mailbox: \`${result.mailbox}\``,
		`- Workspace root: \`${result.workspace_root}\``,
		`- Period root: \`${result.period_root}\``,
		`- Mail staging: \`${result.mail_root}\``,
		`- Inbox staging: \`${result.inbox_root}\``,
		`- Imported messages: ${result.message_count}`,
		`- Imported attachments: ${result.attachment_count}`,
		"",
	];

	for (const message of result.messages) {
		lines.push(`## UID ${message.uid}`, "");
		lines.push(`- Subject: ${message.subject ?? "—"}`);
		lines.push(`- From: ${message.from ?? "—"}`);
		lines.push(`- Date: ${message.date ?? "—"}`);
		lines.push(`- Raw email: \`${message.raw_path}\``);
		for (const attachment of message.attachments) {
			lines.push(
				`- Attachment: \`${attachment.inbox_path}\` (${attachment.size ?? 0} B, ${attachment.content_type ?? "application/octet-stream"})`,
			);
		}
		lines.push("");
	}

	if (result.message_count === 0)
		lines.push("No matching attachment-bearing messages were imported.");
	return lines.join("\n");
}

export default function registerProtonBridgeExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer(
		"protonmail-report",
		(message: { content: string }, { expanded }: { expanded: boolean }, theme: Theme) =>
			renderPreview(message.content, expanded, theme),
	);

	pi.registerCommand("protonmail", {
		description: "Open the Proton Mail setup hub",
		handler: async (args: string, ctx: CommandContext) =>
			runProtonBoundary(
				ctx,
				Effect.gen(function* () {
					const profiles = yield* effectFromProtonPromise(() =>
						listProtonMailWorkingProfiles(ctx.cwd),
					);
					const activeProfile = yield* effectFromProtonPromise(() =>
						resolveProtonMailActiveProfile(ctx.cwd),
					);
					const initialArgs = args.trim() ? args : activeProfile.profile;
					const result = yield* effectFromProtonPromise(() =>
						openProtonMailHub(ctx, profiles, initialArgs),
					);
					if (!result) return;
					yield* effectFromProtonPromise(async () => {
						if (result.kind === "save") {
							await writeProtonMailProfilePolicy(ctx.cwd, result.profile, result.policy);
							await writeProtonMailWorkspaceConfig(ctx.cwd, { activeProfile: result.profile });
							ctx.ui.notify(`Saved Proton Mail profile ${result.profile}`, "info");
							return;
						}
						await deleteProtonMailProfile(ctx.cwd, result.profile);
						const remaining = profiles.filter((profile) => profile.profile !== result.profile);
						const fallback = remaining[0]?.profile ?? "default";
						await writeProtonMailWorkspaceConfig(ctx.cwd, { activeProfile: fallback });
						ctx.ui.notify(`Deleted Proton Mail profile ${result.profile}`, "info");
					});
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
			const profile = await resolveProtonMailActiveProfile(ctx.cwd);
			const result = await protonBridgeStatus(ctx.cwd, profile.policy.default_mailbox);
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
		promptSnippet: "List Proton Bridge mailboxes before choosing one",
		promptGuidelines: [
			"Use this tool after protonmail_bridge_status when you need the exact mailbox name.",
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
			const profile = await resolveProtonMailActiveProfile(ctx.cwd);
			const query = params.query?.trim() || profile.policy.mailbox_filter;
			const result = await listProtonMailboxes(ctx.cwd, query, profile.policy.default_mailbox);
			return {
				content: [
					{ type: "text", text: trimText(formatMailboxSummary(result, query), 160, 16000) },
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
		description: "List recent Proton Bridge messages from a mailbox",
		promptSnippet: "Preview Proton Bridge messages before reading, moving, or importing mail",
		promptGuidelines: [
			"Pass an explicit mailbox or rely on the active profile default mailbox.",
			"Use period to narrow the scan to one month such as 2026-04.",
			"Use searchIn to search fields beyond the default subject/from/messageId/attachments set.",
		],
		parameters: Type.Object({
			mailbox: Type.Optional(
				Type.String({
					description: "Mailbox name; defaults to the active profile mailbox if set",
				}),
			),
			period: Type.Optional(Type.String({ description: "Optional month filter such as 2026-04" })),
			query: Type.Optional(Type.String({ description: "Optional substring filter" })),
			searchIn: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Fields to search: subject, from, to, cc, bcc, body, headers, attachments, messageId",
				}),
			),
			attachmentsOnly: Type.Optional(
				Type.Boolean({ description: "If true, return only messages with attachments" }),
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
				searchIn?: string[];
				attachmentsOnly?: boolean;
				unseenOnly?: boolean;
				limit?: number;
			},
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ToolContext,
		) {
			const profile = await resolveProtonMailActiveProfile(ctx.cwd);
			const period = params.period ? parseMonthPeriod(params.period) : undefined;
			if (params.period && !period)
				throw new Error(`Invalid period \`${params.period}\`. Expected YYYY-MM.`);
			const resolvedPeriod = period ?? profile.policy.default_period;
			// mailbox_filter applies to mailbox discovery, not message contents.
			const query = params.query?.trim() || undefined;
			const result = await listProtonMessages(
				ctx.cwd,
				params.mailbox,
				resolvedPeriod,
				query,
				params.unseenOnly ?? false,
				params.limit ?? 20,
				profile.policy.default_mailbox,
				params.attachmentsOnly ?? false,
				params.searchIn,
			);
			return {
				content: [
					{
						type: "text",
						text: trimText(formatMessageSummary(result, resolvedPeriod), 160, 16000),
					},
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

	pi.registerTool({
		name: "protonmail_get_message",
		label: "ProtonMail Get Message",
		description: "Read a Proton Bridge message by mailbox UID",
		promptSnippet: "Fetch one message's metadata, body, headers, and attachment list",
		promptGuidelines: [
			"Use protonmail_list_messages first when you need to identify the mailbox UID.",
			"Set includeBody or includeHeaders to false when only metadata is needed.",
		],
		parameters: Type.Object({
			mailbox: Type.String({ description: "Mailbox name containing the message" }),
			uid: Type.String({ description: "Message UID in the mailbox" }),
			includeBody: Type.Optional(
				Type.Boolean({ description: "If false, omit text and HTML body content" }),
			),
			includeHeaders: Type.Optional(
				Type.Boolean({ description: "If false, omit parsed message headers" }),
			),
		}),
		async execute(
			_id: string,
			params: { mailbox: string; uid: string; includeBody?: boolean; includeHeaders?: boolean },
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ToolContext,
		) {
			const profile = await resolveProtonMailActiveProfile(ctx.cwd);
			const result = await getProtonMessage(
				ctx.cwd,
				params.mailbox,
				params.uid,
				params.includeBody ?? true,
				params.includeHeaders ?? true,
				profile.policy.default_mailbox,
			);
			return {
				content: [{ type: "text", text: trimText(formatGetMessageSummary(result), 240, 24000) }],
				details: result,
			};
		},
		renderCall(args: { mailbox: string; uid: string }, theme: Theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("protonmail_get_message "))}${theme.fg("dim", `${args.mailbox} UID ${args.uid}`)}`,
				0,
				0,
			);
		},
		renderResult: renderToolResult,
	});

	pi.registerTool({
		name: "protonmail_create_draft",
		label: "ProtonMail Create Draft",
		description: "Create a Proton Mail draft through Bridge IMAP APPEND",
		promptSnippet: "Create a draft with optional attachments in the Drafts mailbox",
		promptGuidelines: [
			"Use from when the sender must be explicit; otherwise the active profile default_from is used.",
			"Attachments are local file paths and are embedded into a multipart MIME message before IMAP APPEND.",
		],
		parameters: Type.Object({
			from: Type.Optional(
				Type.String({ description: "Sender address; defaults to profile default_from" }),
			),
			to: Type.Array(Type.String(), { description: "Recipient email addresses" }),
			cc: Type.Optional(Type.Array(Type.String(), { description: "Cc recipient email addresses" })),
			bcc: Type.Optional(
				Type.Array(Type.String(), { description: "Bcc recipient email addresses" }),
			),
			subject: Type.String({ description: "Email subject" }),
			body: Type.String({ description: "Plain-text email body" }),
			attachments: Type.Optional(
				Type.Array(Type.String(), { description: "Local file paths to attach" }),
			),
			draftsMailbox: Type.Optional(
				Type.String({ description: "Drafts mailbox name; defaults to Drafts" }),
			),
		}),
		async execute(
			_id: string,
			params: {
				from?: string;
				to: string[];
				cc?: string[];
				bcc?: string[];
				subject: string;
				body: string;
				attachments?: string[];
				draftsMailbox?: string;
			},
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ToolContext,
		) {
			const profile = await resolveProtonMailActiveProfile(ctx.cwd);
			const config = await getProtonBridgeConfig(profile.policy.default_mailbox);
			if (!config.username || !config.password)
				throw new Error(protonMailSetupHint(profile.profile));
			const result = await runProtonBridgeCreateDraft(config, {
				cwd: ctx.cwd,
				from: resolveOutgoingFrom(params.from, profile),
				to: params.to,
				cc: params.cc,
				bcc: params.bcc,
				subject: params.subject,
				body: params.body,
				attachments: params.attachments,
				draftsMailbox: params.draftsMailbox,
			});
			return {
				content: [{ type: "text", text: trimText(formatCreateDraftSummary(result), 160, 16000) }],
				details: result,
			};
		},
		renderCall(args: { subject: string; to: string[] }, theme: Theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("protonmail_create_draft "))}${theme.fg("dim", `${args.subject} → ${args.to.join(", ")}`)}`,
				0,
				0,
			);
		},
		renderResult: renderToolResult,
	});

	pi.registerTool({
		name: "protonmail_send",
		label: "ProtonMail Send",
		description: "Send a Proton Mail message through Bridge SMTP",
		promptSnippet: "Send a message with optional attachments through Proton Bridge SMTP",
		promptGuidelines: [
			"Use from when the sender must be explicit; otherwise the active profile default_from is used.",
			"Use saveToMailbox only when a sent or issued copy should also be appended to an IMAP folder.",
			"Labels can be applied only when saveToMailbox is also provided, because the saved copy UID is labeled.",
		],
		parameters: Type.Object({
			from: Type.Optional(
				Type.String({ description: "Sender address; defaults to profile default_from" }),
			),
			to: Type.Array(Type.String(), { description: "Recipient email addresses" }),
			cc: Type.Optional(Type.Array(Type.String(), { description: "Cc recipient email addresses" })),
			bcc: Type.Optional(
				Type.Array(Type.String(), { description: "Bcc recipient email addresses" }),
			),
			subject: Type.String({ description: "Email subject" }),
			body: Type.String({ description: "Plain-text email body" }),
			attachments: Type.Optional(
				Type.Array(Type.String(), { description: "Local file paths to attach" }),
			),
			saveToMailbox: Type.Optional(
				Type.String({ description: "Optional mailbox for appending a sent copy" }),
			),
			labels: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional labels to apply to the saved copy; requires saveToMailbox",
				}),
			),
		}),
		async execute(
			_id: string,
			params: {
				from?: string;
				to: string[];
				cc?: string[];
				bcc?: string[];
				subject: string;
				body: string;
				attachments?: string[];
				saveToMailbox?: string;
				labels?: string[];
			},
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ToolContext,
		) {
			const profile = await resolveProtonMailActiveProfile(ctx.cwd);
			const config = await getProtonBridgeConfig(profile.policy.default_mailbox);
			if (!config.username || !config.password)
				throw new Error(protonMailSetupHint(profile.profile));
			const result = await runProtonBridgeSendMessage(config, {
				cwd: ctx.cwd,
				from: resolveOutgoingFrom(params.from, profile),
				to: params.to,
				cc: params.cc,
				bcc: params.bcc,
				subject: params.subject,
				body: params.body,
				attachments: params.attachments,
				saveToMailbox: params.saveToMailbox,
				labels: params.labels,
			});
			return {
				content: [{ type: "text", text: trimText(formatSendSummary(result), 160, 16000) }],
				details: result,
			};
		},
		renderCall(args: { subject: string; to: string[] }, theme: Theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("protonmail_send "))}${theme.fg("dim", `${args.subject} → ${args.to.join(", ")}`)}`,
				0,
				0,
			);
		},
		renderResult: renderToolResult,
	});

	pi.registerTool({
		name: "protonmail_move_message",
		label: "ProtonMail Move Message",
		description: "Move a Proton Bridge message between IMAP mailboxes",
		promptSnippet: "Move a message UID from one Proton folder to another",
		promptGuidelines: [
			"Use protonmail_list_messages first when you need to identify the source mailbox UID.",
			"Pass the exact mailbox names returned by Proton Bridge.",
		],
		parameters: Type.Object({
			mailbox: Type.String({ description: "Source mailbox name" }),
			uid: Type.String({ description: "Message UID in the source mailbox" }),
			destination: Type.String({ description: "Destination mailbox name" }),
		}),
		async execute(
			_id: string,
			params: { mailbox: string; uid: string; destination: string },
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ToolContext,
		) {
			const profile = await resolveProtonMailActiveProfile(ctx.cwd);
			const config = await getProtonBridgeConfig(profile.policy.default_mailbox);
			if (!config.username || !config.password)
				throw new Error(protonMailSetupHint(profile.profile));
			const result = await runProtonBridgeMoveMessage(config, params);
			return {
				content: [{ type: "text", text: trimText(formatMoveSummary(result), 160, 16000) }],
				details: result,
			};
		},
		renderCall(args: { mailbox: string; uid: string; destination: string }, theme: Theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("protonmail_move_message "))}${theme.fg("dim", `${args.mailbox} UID ${args.uid} → ${args.destination}`)}`,
				0,
				0,
			);
		},
		renderResult: renderToolResult,
	});

	pi.registerTool({
		name: "protonmail_copy_message",
		label: "ProtonMail Copy Message",
		description: "Copy a Proton Bridge message between IMAP mailboxes",
		promptSnippet: "Copy a message UID from one Proton folder to another",
		promptGuidelines: [
			"Use protonmail_list_messages first when you need to identify the source mailbox UID.",
			"Pass the exact mailbox names returned by Proton Bridge.",
		],
		parameters: Type.Object({
			mailbox: Type.String({ description: "Source mailbox name" }),
			uid: Type.String({ description: "Message UID in the source mailbox" }),
			destination: Type.String({ description: "Destination mailbox name" }),
		}),
		async execute(
			_id: string,
			params: { mailbox: string; uid: string; destination: string },
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ToolContext,
		) {
			const profile = await resolveProtonMailActiveProfile(ctx.cwd);
			const config = await getProtonBridgeConfig(profile.policy.default_mailbox);
			if (!config.username || !config.password)
				throw new Error(protonMailSetupHint(profile.profile));
			const result = await runProtonBridgeCopyMessage(config, params);
			return {
				content: [{ type: "text", text: trimText(formatCopySummary(result), 160, 16000) }],
				details: result,
			};
		},
		renderCall(args: { mailbox: string; uid: string; destination: string }, theme: Theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("protonmail_copy_message "))}${theme.fg("dim", `${args.mailbox} UID ${args.uid} → ${args.destination}`)}`,
				0,
				0,
			);
		},
		renderResult: renderToolResult,
	});

	pi.registerTool({
		name: "protonmail_apply_labels",
		label: "ProtonMail Apply Labels",
		description: "Apply Proton labels to a message through Bridge IMAP copy",
		promptSnippet: "Apply one or more Proton labels to a message UID",
		promptGuidelines: [
			"Use protonmail_list_mailboxes when you need the exact label mailbox names returned by Proton Bridge.",
			"Bare label names are resolved to matching mailboxes or Labels/<name> when available.",
		],
		parameters: Type.Object({
			mailbox: Type.String({ description: "Source mailbox name" }),
			uid: Type.String({ description: "Message UID in the source mailbox" }),
			labels: Type.Array(Type.String(), { description: "Labels or label mailbox paths to apply" }),
		}),
		async execute(
			_id: string,
			params: { mailbox: string; uid: string; labels: string[] },
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ToolContext,
		) {
			const profile = await resolveProtonMailActiveProfile(ctx.cwd);
			const config = await getProtonBridgeConfig(profile.policy.default_mailbox);
			if (!config.username || !config.password)
				throw new Error(protonMailSetupHint(profile.profile));
			const result = await runProtonBridgeApplyLabels(config, params);
			return {
				content: [{ type: "text", text: trimText(formatApplyLabelsSummary(result), 160, 16000) }],
				details: result,
			};
		},
		renderCall(args: { mailbox: string; uid: string; labels: string[] }, theme: Theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("protonmail_apply_labels "))}${theme.fg("dim", `${args.mailbox} UID ${args.uid} + ${args.labels.join(", ")}`)}`,
				0,
				0,
			);
		},
		renderResult: renderToolResult,
	});

	pi.registerTool({
		name: "protonmail_import_attachments",
		label: "ProtonMail Import Attachments",
		description: "Stage attachment-bearing Proton Bridge messages into a profile workspace",
		promptSnippet: "Import attachments from Proton Bridge into the active workspace",
		promptGuidelines: [
			"Use the active profile defaults unless the user explicitly overrides mailbox or period.",
			"The tool stages raw mail and attachments under the profile workspace for later adaptation.",
		],
		parameters: Type.Object({
			mailbox: Type.Optional(
				Type.String({
					description: "Mailbox name; defaults to the active profile mailbox if set",
				}),
			),
			period: Type.Optional(Type.String({ description: "Optional month filter such as 2026-04" })),
			query: Type.Optional(
				Type.String({ description: "Optional subject/from/attachment substring filter" }),
			),
			unseenOnly: Type.Optional(Type.Boolean({ description: "If true, limit to unseen messages" })),
			markSeen: Type.Optional(
				Type.Boolean({ description: "If true, mark imported messages as seen" }),
			),
			limit: Type.Optional(Type.Number({ description: "Maximum number of messages to import" })),
			workspaceRoot: Type.Optional(
				Type.String({ description: "Optional relative workspace root for staged imports" }),
			),
		}),
		async execute(
			_id: string,
			params: {
				mailbox?: string;
				period?: string;
				query?: string;
				unseenOnly?: boolean;
				markSeen?: boolean;
				limit?: number;
				workspaceRoot?: string;
			},
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ToolContext,
		) {
			const profile = await resolveProtonMailActiveProfile(ctx.cwd);
			const period = params.period ? parseMonthPeriod(params.period) : undefined;
			if (params.period && !period)
				throw new Error(`Invalid period \`${params.period}\`. Expected YYYY-MM.`);
			const resolvedPeriod = period ?? profile.policy.default_period;
			if (!resolvedPeriod)
				throw new Error("No period provided and the active profile has no default_period.");
			// mailbox_filter applies to mailbox discovery, not message contents.
			const query = params.query?.trim() || undefined;
			const config = await getProtonBridgeConfig(profile.policy.default_mailbox);
			if (!config.username || !config.password)
				throw new Error(protonMailSetupHint(profile.profile));
			const workspaceRoot = resolveProtonMailImportWorkspaceRoot(
				profile.profile,
				params.workspaceRoot || profile.policy.import_workspace_root,
			);
			const result = await runProtonBridgeImportAttachments(config, {
				cwd: ctx.cwd,
				workspaceRoot,
				period: resolvedPeriod,
				mailbox: params.mailbox,
				profile: profile.profile,
				query,
				unseenOnly: params.unseenOnly ?? false,
				markSeen: params.markSeen ?? false,
				limit: params.limit ?? 100,
			});
			return {
				content: [
					{ type: "text", text: trimText(formatImportSummary(result, resolvedPeriod), 160, 16000) },
				],
				details: result,
			};
		},
		renderCall(args: { mailbox?: string; period?: string }, theme: Theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("protonmail_import_attachments "))}${theme.fg("dim", `${args.mailbox ?? "default mailbox"}${args.period ? ` ${args.period}` : ""}`)}`,
				0,
				0,
			);
		},
		renderResult: renderToolResult,
	});
}
