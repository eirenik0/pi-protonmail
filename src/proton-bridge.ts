import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, isAbsolute, join, relative } from "node:path";

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";

import type {
	BridgeStatusResult,
	CreateDraftResult,
	MailboxInfo,
	MailboxListResult,
	MessageInfo,
	MessageListResult,
	MoveMessageResult,
	ProtonBridgeConfig,
	SendMessageResult,
} from "./types.ts";

export interface ProtonBridgeImportResult {
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
		message_id?: string;
		from?: string;
		subject?: string;
		date?: string;
		attachment_count: number;
		raw_path: string;
		saved_at: string;
		attachments: Array<{
			filename: string;
			content_type?: string;
			size?: number;
			mail_path: string;
			inbox_path: string;
		}>;
	}>;
}

interface ImportOptions {
	cwd: string;
	workspaceRoot: string;
	period: string;
	mailbox?: string;
	profile: string;
	unseenOnly?: boolean;
	query?: string;
	markSeen?: boolean;
	limit?: number;
}

interface OutgoingMessageOptions {
	cwd: string;
	from: string;
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	body: string;
	attachments?: string[];
}

interface CreateDraftOptions extends OutgoingMessageOptions {
	draftsMailbox?: string;
}

interface SendMessageOptions extends OutgoingMessageOptions {
	saveToMailbox?: string;
}

interface MoveMessageOptions {
	mailbox: string;
	uid: string;
	destination: string;
}

function sanitizeFilename(value: string): string {
	const text = value.replace(/[\\/:*?"<>|\r\n]+/g, "_").trim();
	return text.replace(/\s+/g, " ") || "unnamed";
}

function sanitizePathSegment(value: string): string {
	const text = value.replace(/[^A-Za-z0-9._-]+/g, "-").trim();
	return text.replace(/^[-._]+|[-._]+$/g, "") || "item";
}

function monthRange(period: string): { since: Date; before: Date } {
	if (!/^\d{4}-\d{2}$/.test(period))
		throw new Error(`Invalid period '${period}'. Expected YYYY-MM.`);
	const year = Number.parseInt(period.slice(0, 4), 10);
	const month = Number.parseInt(period.slice(5, 7), 10);
	const since = new Date(Date.UTC(year, month - 1, 1));
	const before =
		month === 12 ? new Date(Date.UTC(year + 1, 0, 1)) : new Date(Date.UTC(year, month, 1));
	return { since, before };
}

function toStringValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value && typeof value === "object" && "toString" in value) return String(value);
	return "";
}

async function probePort(
	host: string,
	port: number,
	timeout = 1500,
): Promise<{ open: boolean; banner?: string; error?: string }> {
	return new Promise((resolve) => {
		const socket = createConnection({ host, port });
		let banner = "";
		let settled = false;

		const finish = (result: { open: boolean; banner?: string; error?: string }) => {
			if (settled) return;
			settled = true;
			try {
				socket.destroy();
			} catch {
				// ignore
			}
			resolve(result);
		};

		socket.setTimeout(timeout);
		socket.on("data", (chunk) => {
			banner += chunk.toString("utf8");
		});
		socket.on("connect", () => {
			setTimeout(() => finish({ open: true, banner: banner.trim() || undefined }), 50);
		});
		socket.on("timeout", () => finish({ open: false, error: "timed out" }));
		socket.on("error", (error) =>
			finish({ open: false, error: error instanceof Error ? error.message : String(error) }),
		);
	});
}

function normalizeSecurity(security: string): "ssl" | "starttls" | "auto" | "plain" {
	const value = security.trim().toLowerCase();
	if (value === "ssl" || value === "starttls" || value === "plain" || value === "auto")
		return value;
	return "starttls";
}

async function connectImap(config: ProtonBridgeConfig): Promise<ImapFlow> {
	const security = normalizeSecurity(config.security);
	const client = new ImapFlow({
		host: config.host,
		port: config.imapPort,
		secure: security === "ssl",
		doSTARTTLS: security === "starttls" || security === "auto",
		auth: {
			user: config.username ?? "",
			pass: config.password ?? "",
		},
		tls: {
			rejectUnauthorized: false,
		},
	});
	await client.connect();
	return client;
}

async function listMailboxes(client: ImapFlow): Promise<MailboxInfo[]> {
	const mailboxes: MailboxInfo[] = [];
	const listing = await client.list();
	for await (const row of listing as AsyncIterable<Record<string, unknown>>) {
		const name = toStringValue(row.path ?? row.name ?? row.mailbox ?? row.id ?? row.raw).trim();
		const raw = toStringValue(row.raw).trim() || undefined;
		const flags = Array.isArray(row.flags)
			? row.flags.map((flag) => toStringValue(flag)).filter(Boolean)
			: undefined;
		const delimiter = row.delimiter == null ? null : toStringValue(row.delimiter);
		mailboxes.push({
			name: name || raw || "unnamed",
			raw,
			flags,
			delimiter,
		});
	}
	mailboxes.sort((left, right) => left.name.localeCompare(right.name));
	return mailboxes;
}

function monthSearch(period?: string): { since?: Date; before?: Date } {
	if (!period) return {};
	const { since, before } = monthRange(period);
	return { since, before };
}

async function searchUids(
	client: ImapFlow,
	mailbox: string,
	period?: string,
	unseenOnly = false,
	readOnly = true,
): Promise<string[]> {
	await client.mailboxOpen(mailbox, { readOnly });
	const search: Record<string, unknown> = { uid: true };
	if (unseenOnly) search.seen = false;
	else search.all = true;
	Object.assign(search, monthSearch(period));
	const result = await client.search(search as Record<string, unknown>, { uid: true });
	const uids = Array.isArray(result) ? result : [];
	return uids.map((uid) => String(uid));
}

function messageFromParsed(
	uid: string,
	parsed: Awaited<ReturnType<typeof simpleParser>>,
	rawSize?: number,
): MessageInfo {
	const from = parsed.from?.text?.trim() || undefined;
	const subject = parsed.subject?.trim() || undefined;
	const date = parsed.date instanceof Date ? parsed.date.toISOString() : undefined;
	const attachments = parsed.attachments.map((attachment) => ({
		filename: attachment.filename || "attachment",
		content_type: attachment.contentType || undefined,
		size: attachment.size || attachment.content?.length || undefined,
	}));
	return {
		uid,
		message_id: parsed.messageId?.trim() || undefined,
		from,
		subject,
		date,
		attachments,
		attachment_count: attachments.length,
		raw_size: rawSize,
	};
}

function matchesQuery(summary: MessageInfo, query?: string): boolean {
	if (!query?.trim()) return true;
	const needle = query.trim().toLowerCase();
	const values = [
		summary.subject,
		summary.from,
		summary.message_id,
		...summary.attachments.map((attachment) => attachment.filename),
	];
	return values.some((value) => value?.toLowerCase().includes(needle));
}

async function fetchParsedMessage(
	client: ImapFlow,
	uid: string,
): Promise<{ parsed: Awaited<ReturnType<typeof simpleParser>>; source: Buffer }> {
	const message = (await client.fetchOne(uid, { uid: true, source: true })) as Record<
		string,
		unknown
	>;
	const source =
		message.source instanceof Buffer
			? message.source
			: Buffer.from(message.source as Uint8Array | string);
	const parsed = await simpleParser(source);
	return { parsed, source };
}

async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

function requireBridgeCredentials(
	config: ProtonBridgeConfig,
): asserts config is ProtonBridgeConfig & {
	username: string;
	password: string;
} {
	if (!config.username || !config.password)
		throw new Error("Missing Proton Bridge username/password.");
}

function resolveLocalPath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : join(cwd, path);
}

async function buildAttachmentOptions(
	cwd: string,
	attachments?: string[],
): Promise<Mail.Attachment[]> {
	const files: Mail.Attachment[] = [];
	for (const attachmentPath of attachments ?? []) {
		const path = resolveLocalPath(cwd, attachmentPath);
		files.push({
			filename: basename(path),
			content: await readFile(path),
		});
	}
	return files;
}

async function buildMimeMessage(options: OutgoingMessageOptions, keepBcc = false): Promise<Buffer> {
	const message = new MailComposer({
		from: options.from,
		to: options.to,
		cc: options.cc,
		bcc: options.bcc,
		subject: options.subject,
		text: options.body,
		attachments: await buildAttachmentOptions(options.cwd, options.attachments),
	});
	const node = message.compile();
	if (keepBcc) (node as unknown as { keepBcc: boolean }).keepBcc = true;
	return node.build();
}

function appendUid(result: unknown): string | undefined {
	if (!result || typeof result !== "object" || !("uid" in result)) return undefined;
	const uid = (result as { uid?: unknown }).uid;
	return uid == null ? undefined : String(uid);
}

function allRecipients(options: OutgoingMessageOptions): string[] {
	return [...options.to, ...(options.cc ?? []), ...(options.bcc ?? [])].filter(Boolean);
}

function messageIdFromRaw(raw: Buffer): string | undefined {
	const match = raw.toString("utf8").match(/^Message-ID:\s*(.+)$/im);
	return match?.[1]?.trim();
}

export async function protonBridgeStatus(config: ProtonBridgeConfig): Promise<BridgeStatusResult> {
	const imapProbe = await probePort(config.host, config.imapPort);
	const smtpProbe = await probePort(config.host, config.smtpPort);
	const result: BridgeStatusResult = {
		config: {
			host: config.host,
			imap_port: config.imapPort,
			smtp_port: config.smtpPort,
			security: config.security,
			default_mailbox: config.defaultMailbox,
			username_set: Boolean(config.username),
			password_set: Boolean(config.password),
		},
		imap: imapProbe,
		smtp: smtpProbe,
	};

	if (config.username && config.password && imapProbe.open) {
		let client: ImapFlow | undefined;
		try {
			client = await connectImap(config);
			const mailboxes = await listMailboxes(client);
			result.login = {
				ok: true,
				mailbox_count: mailboxes.length,
				mailboxes: mailboxes.slice(0, 10).map((mailbox) => ({ name: mailbox.name })),
			};
		} catch (error) {
			result.login = { ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			await client?.logout().catch(() => undefined);
		}
	}

	return result;
}

export async function protonBridgeListMailboxes(
	config: ProtonBridgeConfig,
	query?: string,
): Promise<MailboxListResult> {
	if (!config.username || !config.password)
		throw new Error("Missing Proton Bridge username/password.");
	let client: ImapFlow | undefined;
	try {
		client = await connectImap(config);
		const rows = await listMailboxes(client);
		const filtered = query?.trim()
			? rows.filter((row) => {
					const needle = query.trim().toLowerCase();
					return [row.name, row.raw ?? ""].some((value) => value.toLowerCase().includes(needle));
				})
			: rows;
		return { mailboxes: filtered, count: filtered.length };
	} finally {
		await client?.logout().catch(() => undefined);
	}
}

export async function protonBridgeListMessages(
	config: ProtonBridgeConfig,
	mailbox: string | undefined,
	period?: string,
	query?: string,
	unseenOnly = false,
	limit = 20,
): Promise<MessageListResult> {
	if (!config.username || !config.password)
		throw new Error("Missing Proton Bridge username/password.");
	const selectedMailbox = mailbox || config.defaultMailbox;
	if (!selectedMailbox)
		throw new Error("No mailbox provided and PROTON_BRIDGE_DEFAULT_MAILBOX is not set.");
	let client: ImapFlow | undefined;
	try {
		client = await connectImap(config);
		const uids = await searchUids(client, selectedMailbox, period, unseenOnly);
		const messages: MessageInfo[] = [];
		for (const uid of [...uids].reverse()) {
			const { parsed, source } = await fetchParsedMessage(client, uid);
			const summary = messageFromParsed(uid, parsed, source.length);
			if (!summary.attachment_count) continue;
			if (!matchesQuery(summary, query)) continue;
			messages.push(summary);
			if (messages.length >= limit) break;
		}
		return { mailbox: selectedMailbox, count: messages.length, messages };
	} finally {
		await client?.logout().catch(() => undefined);
	}
}

export async function protonBridgeCreateDraft(
	config: ProtonBridgeConfig,
	options: CreateDraftOptions,
): Promise<CreateDraftResult> {
	requireBridgeCredentials(config);
	const mailbox = options.draftsMailbox?.trim() || "Drafts";
	const raw = await buildMimeMessage(options, true);
	let client: ImapFlow | undefined;
	try {
		client = await connectImap(config);
		const result = await client.append(mailbox, raw, ["\\Draft", "\\Seen"], new Date());
		return {
			mailbox,
			uid: appendUid(result),
			from: options.from,
			to: options.to,
			cc: options.cc,
			bcc: options.bcc,
			subject: options.subject,
			attachment_count: options.attachments?.length ?? 0,
		};
	} finally {
		await client?.logout().catch(() => undefined);
	}
}

export async function protonBridgeSendMessage(
	config: ProtonBridgeConfig,
	options: SendMessageOptions,
): Promise<SendMessageResult> {
	requireBridgeCredentials(config);
	const raw = await buildMimeMessage(options);
	const security = normalizeSecurity(config.security);
	const transport = nodemailer.createTransport({
		host: config.host,
		port: config.smtpPort,
		secure: security === "ssl",
		ignoreTLS: security === "plain",
		requireTLS: security === "starttls",
		auth: {
			user: config.username,
			pass: config.password,
		},
		tls: {
			rejectUnauthorized: false,
		},
	});

	let messageId = messageIdFromRaw(raw);
	try {
		const info = await transport.sendMail({
			envelope: {
				from: options.from,
				to: allRecipients(options),
			},
			raw,
		});
		if (typeof info.messageId === "string") messageId = info.messageId;
	} finally {
		transport.close();
	}

	const result: SendMessageResult = {
		from: options.from,
		to: options.to,
		cc: options.cc,
		bcc: options.bcc,
		subject: options.subject,
		attachment_count: options.attachments?.length ?? 0,
		message_id: messageId,
	};

	const saveToMailbox = options.saveToMailbox?.trim();
	if (saveToMailbox) {
		let client: ImapFlow | undefined;
		try {
			client = await connectImap(config);
			const appendResult = await client.append(saveToMailbox, raw, ["\\Seen"], new Date());
			result.saved_to_mailbox = saveToMailbox;
			result.saved_uid = appendUid(appendResult);
		} finally {
			await client?.logout().catch(() => undefined);
		}
	}

	return result;
}

export async function protonBridgeMoveMessage(
	config: ProtonBridgeConfig,
	options: MoveMessageOptions,
): Promise<MoveMessageResult> {
	requireBridgeCredentials(config);
	let client: ImapFlow | undefined;
	try {
		client = await connectImap(config);
		await client.mailboxOpen(options.mailbox, { readOnly: false });
		await client.messageMove(options.uid, options.destination, { uid: true });
		return {
			uid: options.uid,
			source: options.mailbox,
			destination: options.destination,
		};
	} finally {
		await client?.logout().catch(() => undefined);
	}
}

export async function protonBridgeImportAttachments(
	config: ProtonBridgeConfig,
	options: ImportOptions,
): Promise<ProtonBridgeImportResult> {
	if (!config.username || !config.password)
		throw new Error("Missing Proton Bridge username/password.");
	const selectedMailbox = options.mailbox || config.defaultMailbox;
	if (!selectedMailbox)
		throw new Error("No mailbox provided and PROTON_BRIDGE_DEFAULT_MAILBOX is not set.");
	if (!/^\d{4}-\d{2}$/.test(options.period))
		throw new Error(`Invalid period '${options.period}'. Expected YYYY-MM.`);

	const workspaceRoot = options.workspaceRoot.trim();
	const baseRoot = join(options.cwd, workspaceRoot);
	const periodRoot = join(baseRoot, options.period);
	const mailRoot = join(periodRoot, "_mail", sanitizePathSegment(selectedMailbox));
	const inboxRoot = join(periodRoot, "_inbox");
	await ensureDir(mailRoot);
	await ensureDir(inboxRoot);

	let client: ImapFlow | undefined;
	const importedMessages: ProtonBridgeImportResult["messages"] = [];
	let importedAttachmentCount = 0;
	try {
		client = await connectImap(config);
		const uids = await searchUids(
			client,
			selectedMailbox,
			options.period,
			options.unseenOnly,
			!options.markSeen,
		);
		const selected = [...uids].reverse().slice(0, Math.max(options.limit ?? 100, 1) * 10);

		for (const uid of selected) {
			const { parsed, source } = await fetchParsedMessage(client, uid);
			const summary = messageFromParsed(uid, parsed, source.length);
			if (summary.attachment_count === 0) continue;
			if (!matchesQuery(summary, options.query)) continue;

			const messageDir = join(mailRoot, `uid-${uid}`);
			await ensureDir(messageDir);
			const rawPath = join(messageDir, "raw.eml");
			await writeFile(rawPath, source);

			const attachments: ProtonBridgeImportResult["messages"][number]["attachments"] = [];
			for (const [index, attachment] of parsed.attachments.entries()) {
				const filename = sanitizeFilename(attachment.filename || `attachment-${index + 1}`);
				const savedName = `${String(index + 1).padStart(2, "0")}__${filename}`;
				const attachmentPath = join(messageDir, savedName);
				await writeFile(attachmentPath, attachment.content);

				const inboxName = `uid-${uid}__${savedName}`;
				const inboxPath = join(inboxRoot, inboxName);
				try {
					await access(inboxPath);
				} catch {
					await copyFile(attachmentPath, inboxPath);
				}

				attachments.push({
					filename,
					content_type: attachment.contentType || undefined,
					size: attachment.size || attachment.content?.length || undefined,
					mail_path: relative(options.cwd, attachmentPath),
					inbox_path: relative(options.cwd, inboxPath),
				});
				importedAttachmentCount += 1;
			}

			const meta = {
				workspace_root: workspaceRoot,
				period: options.period,
				mailbox: selectedMailbox,
				uid,
				message_id: parsed.messageId?.trim() || undefined,
				from: summary.from,
				subject: summary.subject,
				date: summary.date,
				attachment_count: attachments.length,
				attachments,
				raw_path: relative(options.cwd, rawPath),
				saved_at: new Date().toISOString(),
			};
			await writeFile(join(messageDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
			importedMessages.push(meta);

			if (options.markSeen) {
				await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
			}
			if (importedMessages.length >= (options.limit ?? 100)) break;
		}
		return {
			workspace_root: relative(options.cwd, baseRoot),
			period_root: relative(options.cwd, periodRoot),
			mail_root: relative(options.cwd, mailRoot),
			inbox_root: relative(options.cwd, inboxRoot),
			mailbox: selectedMailbox,
			profile: sanitizePathSegment(options.profile),
			message_count: importedMessages.length,
			attachment_count: importedAttachmentCount,
			messages: importedMessages,
		};
	} finally {
		await client?.logout().catch(() => undefined);
	}
}
