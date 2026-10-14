import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection, isIP, type Socket } from "node:net";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import tls from "node:tls";

import { ImapFlow } from "imapflow";
import { type AddressObject, simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";

import { BRIDGE_CANCELLED_MESSAGE } from "./constants.ts";
import type {
	ApplyLabelsResult,
	BridgeStatusResult,
	CopyMessageResult,
	CreateDraftResult,
	GetMessageResult,
	MailboxInfo,
	MailboxListResult,
	MessageAttachmentInfo,
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

interface GetMessageOptions {
	mailbox: string;
	uid: string;
	includeBody?: boolean;
	includeHeaders?: boolean;
}

interface CreateDraftOptions extends OutgoingMessageOptions {
	draftsMailbox?: string;
}

interface SendMessageOptions extends OutgoingMessageOptions {
	saveToMailbox?: string;
	labels?: string[];
}

interface MoveMessageOptions {
	mailbox: string;
	uid: string;
	destination: string;
}

interface CopyMessageOptions {
	mailbox: string;
	uid: string;
	destination: string;
}

interface ApplyLabelsOptions {
	mailbox: string;
	uid: string;
	labels: string[];
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
	signal?: AbortSignal,
): Promise<{ open: boolean; banner?: string; error?: string }> {
	return new Promise((resolve) => {
		const socket = createConnection({ host, port });
		let banner = "";
		let settled = false;

		const finish = (result: { open: boolean; banner?: string; error?: string }) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			try {
				socket.destroy();
			} catch {
				// ignore
			}
			resolve(result);
		};
		const onAbort = () => finish({ open: false, error: "cancelled" });

		if (signal?.aborted) {
			finish({ open: false, error: "cancelled" });
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
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

export const BRIDGE_CONNECTION_TIMEOUT_MS = 10_000;
export const BRIDGE_GREETING_TIMEOUT_MS = 10_000;
export const BRIDGE_SOCKET_TIMEOUT_MS = 60_000;
export const BRIDGE_LOGOUT_TIMEOUT_MS = 5_000;
export { BRIDGE_CANCELLED_MESSAGE };

export interface BridgeTimeouts {
	connectionMs: number;
	greetingMs: number;
	socketMs: number;
	logoutMs: number;
}

export const defaultBridgeTimeouts: BridgeTimeouts = {
	connectionMs: BRIDGE_CONNECTION_TIMEOUT_MS,
	greetingMs: BRIDGE_GREETING_TIMEOUT_MS,
	socketMs: BRIDGE_SOCKET_TIMEOUT_MS,
	logoutMs: BRIDGE_LOGOUT_TIMEOUT_MS,
};

export interface BridgeCallOptions {
	signal?: AbortSignal;
	timeouts?: Partial<BridgeTimeouts>;
}

function resolveTimeouts(options?: BridgeCallOptions): BridgeTimeouts {
	return { ...defaultBridgeTimeouts, ...options?.timeouts };
}

function cancelledError(): Error {
	return new Error(BRIDGE_CANCELLED_MESSAGE);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw cancelledError();
}

// Socket timeouts after login are emitted as EventEmitter "error" events.
// The in-flight command rejects when the socket closes; this listener only
// keeps Node from crashing on an error event with no subscriber.
function ignoreImapSocketError(): void {}

function createImapClient(config: ProtonBridgeConfig, timeouts: BridgeTimeouts): ImapFlow {
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
		connectionTimeout: timeouts.connectionMs,
		greetingTimeout: timeouts.greetingMs,
		socketTimeout: timeouts.socketMs,
		// ImapFlow's default pino logger writes debug lines (including AUTH
		// payloads) straight to stdout, which corrupts pi's fullscreen TUI.
		logger: false,
	});
	client.on("error", ignoreImapSocketError);
	return client;
}

function bindImapAbort(client: ImapFlow, signal?: AbortSignal): () => void {
	if (!signal) return () => {};
	const onAbort = () => {
		try {
			client.close();
		} catch {
			// already closed
		}
	};
	if (signal.aborted) {
		onAbort();
		return () => {};
	}
	signal.addEventListener("abort", onAbort, { once: true });
	return () => signal.removeEventListener("abort", onAbort);
}

async function closeImap(client: ImapFlow, logoutMs: number, force: boolean): Promise<void> {
	if (!force) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const logout = client.logout().then(
			() => undefined,
			() => undefined,
		);
		try {
			await Promise.race([
				logout,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, logoutMs);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	try {
		client.close();
	} catch {
		// already closed
	}
}

async function withImap<T>(
	config: ProtonBridgeConfig,
	options: BridgeCallOptions | undefined,
	run: (client: ImapFlow) => Promise<T>,
): Promise<T> {
	throwIfAborted(options?.signal);
	const timeouts = resolveTimeouts(options);
	const client = createImapClient(config, timeouts);
	const unbind = bindImapAbort(client, options?.signal);
	let connected = false;
	try {
		await client.connect();
		connected = true;
		throwIfAborted(options?.signal);
		const result = await run(client);
		throwIfAborted(options?.signal);
		return result;
	} catch (error) {
		if (options?.signal?.aborted) throw cancelledError();
		throw error;
	} finally {
		try {
			// Keep the abort listener until logout finishes so Esc during LOGOUT
			// closes the socket instead of waiting out the logout bound.
			// A failed connect is closed without LOGOUT because the caller never
			// receives that client.
			await closeImap(client, timeouts.logoutMs, !connected || Boolean(options?.signal?.aborted));
		} finally {
			unbind();
		}
	}
}

function destroySmtpSocket(socket: Socket | undefined): void {
	if (!socket || socket.destroyed) return;
	// An error object makes Nodemailer run its error path, which clears the
	// greeting timer. destroy() with no error only emits "close" and leaves it.
	socket.destroy(cancelledError());
}

function createSmtpTransport(
	config: ProtonBridgeConfig,
	timeouts: BridgeTimeouts,
	signal?: AbortSignal,
) {
	const security = normalizeSecurity(config.security);
	let socket: Socket | undefined;
	let handedOff = false;
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
		logger: false,
		connectionTimeout: timeouts.connectionMs,
		greetingTimeout: timeouts.greetingMs,
		socketTimeout: timeouts.socketMs,
		// Own the TCP or TLS socket for every security mode. transport.close()
		// does not close the live SMTP connection.
		getSocket(
			_options: unknown,
			callback: (
				error: Error | null,
				socketOptions: { connection?: Socket; secured?: boolean },
			) => void,
		) {
			if (signal?.aborted) {
				callback(cancelledError(), {});
				return;
			}
			let settled = false;
			const finish = (
				error: Error | null,
				socketOptions: { connection?: Socket; secured?: boolean },
			) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (error) destroySmtpSocket(socket);
				else handedOff = true;
				callback(error, socketOptions);
			};
			const onAbort = () => finish(cancelledError(), {});
			signal?.addEventListener("abort", onAbort, { once: true });
			const timer = setTimeout(
				() => finish(new Error("SMTP connection timed out"), {}),
				timeouts.connectionMs,
			);
			try {
				socket =
					security === "ssl"
						? tls.connect({
								host: config.host,
								port: config.smtpPort,
								...(isIP(config.host) ? {} : { servername: config.host }),
								rejectUnauthorized: false,
							})
						: createConnection({ host: config.host, port: config.smtpPort });
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)), {});
				return;
			}
			socket.on("error", () => {
				// Keep a listener so a destroyed socket cannot crash the process
				// before Nodemailer attaches its own handler.
			});
			socket.once("error", (error) => {
				finish(error instanceof Error ? error : new Error(String(error)), {});
			});
			socket.once(security === "ssl" ? "secureConnect" : "connect", () => {
				if (!socket) return;
				finish(
					null,
					security === "ssl" ? { connection: socket, secured: true } : { connection: socket },
				);
			});
		},
	});
	return {
		transport,
		destroy() {
			destroySmtpSocket(socket);
			if (!handedOff) socket = undefined;
			transport.close();
		},
	};
}

async function listMailboxes(client: ImapFlow): Promise<MailboxInfo[]> {
	const mailboxes: MailboxInfo[] = [];
	const listing = await client.list();
	for (const entry of listing) {
		const row = entry as unknown as Record<string, unknown>;
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

const SEARCH_FIELDS = [
	"subject",
	"from",
	"to",
	"cc",
	"bcc",
	"body",
	"headers",
	"attachments",
	"messageid",
	"message-id",
];

// ImapFlow surfaces a failed SELECT as a bare "Command failed"; name the mailbox instead.
async function openMailbox(client: ImapFlow, mailbox: string, readOnly: boolean): Promise<void> {
	try {
		await client.mailboxOpen(mailbox, { readOnly });
	} catch (error) {
		throw new Error(
			`Mailbox "${mailbox}" could not be opened (${error instanceof Error ? error.message : String(error)}). Use protonmail_list_mailboxes for exact names.`,
		);
	}
}

export function assertUid(uid: string): void {
	if (!/^[1-9]\d*$/.test(uid.trim()))
		throw new Error(`Invalid message UID "${uid}". Expected a positive number.`);
}

// messageMove/messageCopy return false instead of throwing, so a missing UID or
// destination would otherwise be reported as success.
async function assertUidExists(client: ImapFlow, mailbox: string, uid: string): Promise<void> {
	assertUid(uid);
	const found = await client.search({ uid }, { uid: true });
	if (!Array.isArray(found) || !found.includes(Number(uid)))
		throw new Error(`Message UID ${uid} was not found in "${mailbox}".`);
}

function assertWriteResult(
	result: unknown,
	action: string,
	uid: string,
	destination: string,
): void {
	if (result === false)
		throw new Error(
			`Could not ${action} UID ${uid} to "${destination}". Check that the destination mailbox exists with protonmail_list_mailboxes.`,
		);
}

export function assertPositiveInteger(value: number, label: string): void {
	if (!Number.isInteger(value) || value < 1)
		throw new Error(`Invalid ${label} ${value}. Expected a positive integer.`);
}

export function validateSearchFields(fields?: string[]): void {
	const invalid = (fields ?? []).filter((field) => !SEARCH_FIELDS.includes(field.toLowerCase()));
	if (invalid.length)
		throw new Error(
			`Unknown searchIn field(s): ${invalid.join(", ")}. Use: subject, from, to, cc, bcc, body, headers, attachments, messageId.`,
		);
}

async function searchUids(
	client: ImapFlow,
	mailbox: string,
	period?: string,
	unseenOnly = false,
	readOnly = true,
	criteria?: Record<string, unknown>,
): Promise<string[]> {
	await openMailbox(client, mailbox, readOnly);
	const search: Record<string, unknown> = { ...(criteria ?? {}) };
	if (unseenOnly) search.seen = false;
	else if (!criteria) search.all = true;
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

function addressText(value: AddressObject | AddressObject[] | undefined): string | undefined {
	if (!value) return undefined;
	const list = Array.isArray(value) ? value : [value];
	const text = list
		.map((entry) => entry.text?.trim())
		.filter(Boolean)
		.join(", ");
	return text || undefined;
}

function matchesQuery(
	summary: MessageInfo,
	parsed: Awaited<ReturnType<typeof simpleParser>>,
	query?: string,
	searchFields?: string[],
): boolean {
	if (!query?.trim()) return true;
	const needle = query.trim().toLowerCase();
	const fields = new Set(
		(searchFields?.length ? searchFields : ["subject", "from", "messageId", "attachments"]).map(
			(field) => field.toLowerCase(),
		),
	);
	const values: Array<string | undefined> = [];
	if (fields.has("subject")) values.push(summary.subject);
	if (fields.has("from")) values.push(summary.from);
	if (fields.has("to")) values.push(addressText(parsed.to));
	if (fields.has("cc")) values.push(addressText(parsed.cc));
	if (fields.has("bcc")) values.push(addressText(parsed.bcc));
	if (fields.has("messageid") || fields.has("message-id")) values.push(summary.message_id);
	if (fields.has("attachments")) {
		values.push(...summary.attachments.map((attachment) => attachment.filename));
	}
	if (fields.has("body")) {
		values.push(parsed.text);
		if (typeof parsed.html === "string") values.push(parsed.html);
	}
	if (fields.has("headers")) {
		values.push(
			...[...parsed.headers.entries()].map(([name, value]) => `${name}: ${toStringValue(value)}`),
		);
	}
	return values.some((value) => value?.toLowerCase().includes(needle));
}

async function fetchParsedMessage(
	client: ImapFlow,
	uid: string,
): Promise<{ parsed: Awaited<ReturnType<typeof simpleParser>>; source: Buffer }> {
	// Search results are UIDs, so the UID flag belongs in fetchOne's options.
	// Without the third argument ImapFlow interprets the UID as a sequence number.
	const fetched = await client.fetchOne(uid, { source: true }, { uid: true });
	if (!fetched) throw new Error(`Message UID ${uid} was not found`);
	const message = fetched as unknown as Record<string, unknown>;
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

function copyUid(result: unknown, sourceUid: string): string | undefined {
	if (!result || typeof result !== "object" || !("uidMap" in result)) return undefined;
	const uidMap = (result as { uidMap?: Map<number, number> }).uidMap;
	if (!uidMap || typeof uidMap.get !== "function") return undefined;
	const copiedUid = uidMap.get(Number(sourceUid));
	return copiedUid == null ? undefined : String(copiedUid);
}

function allRecipients(options: OutgoingMessageOptions): string[] {
	return [...options.to, ...(options.cc ?? []), ...(options.bcc ?? [])].filter(Boolean);
}

function messageIdFromRaw(raw: Buffer): string | undefined {
	const match = raw.toString("utf8").match(/^Message-ID:\s*(.+)$/im);
	return match?.[1]?.trim();
}

function headersFromParsed(
	parsed: Awaited<ReturnType<typeof simpleParser>>,
): GetMessageResult["headers"] {
	return [...parsed.headers.entries()].map(([name, value]) => ({
		name,
		value: Array.isArray(value)
			? value.map((item) => toStringValue(item)).join(", ")
			: toStringValue(value),
	}));
}

function resolveLabelMailbox(label: string, mailboxes: MailboxInfo[]): string {
	const trimmed = label.trim();
	const candidates = [trimmed, `Labels/${trimmed}`];
	for (const candidate of candidates) {
		const exact = mailboxes.find((mailbox) => mailbox.name === candidate);
		if (exact) return exact.name;
	}
	for (const candidate of candidates) {
		const lower = candidate.toLowerCase();
		const match = mailboxes.find((mailbox) => mailbox.name.toLowerCase() === lower);
		if (match) return match.name;
	}
	const available = mailboxes
		.filter((mailbox) => mailbox.name.toLowerCase().includes("label"))
		.slice(0, 20)
		.map((mailbox) => mailbox.name);
	const hint = available.length
		? ` Available label mailboxes: ${available.join(", ")}.`
		: " Run protonmail_list_mailboxes to inspect available label mailbox paths.";
	throw new Error(`Label mailbox "${trimmed}" was not found.${hint}`);
}

export async function protonBridgeStatus(
	config: ProtonBridgeConfig,
	options?: BridgeCallOptions,
): Promise<BridgeStatusResult> {
	throwIfAborted(options?.signal);
	const imapProbe = await probePort(config.host, config.imapPort, 1500, options?.signal);
	throwIfAborted(options?.signal);
	const smtpProbe = await probePort(config.host, config.smtpPort, 1500, options?.signal);
	throwIfAborted(options?.signal);
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
		try {
			const mailboxes = await withImap(config, options, (client) => listMailboxes(client));
			result.login = {
				ok: true,
				mailbox_count: mailboxes.length,
				mailboxes: mailboxes.slice(0, 10).map((mailbox) => ({ name: mailbox.name })),
			};
		} catch (error) {
			if (
				options?.signal?.aborted ||
				(error instanceof Error && error.message === BRIDGE_CANCELLED_MESSAGE)
			)
				throw error instanceof Error && error.message === BRIDGE_CANCELLED_MESSAGE
					? error
					: cancelledError();
			result.login = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	return result;
}

export async function protonBridgeListMailboxes(
	config: ProtonBridgeConfig,
	query?: string,
	options?: BridgeCallOptions,
): Promise<MailboxListResult> {
	if (!config.username || !config.password)
		throw new Error("Missing Proton Bridge username/password.");
	return withImap(config, options, async (client) => {
		const rows = await listMailboxes(client);
		const filtered = query?.trim()
			? rows.filter((row) => {
					const needle = query.trim().toLowerCase();
					return [row.name, row.raw ?? ""].some((value) => value.toLowerCase().includes(needle));
				})
			: rows;
		return { mailboxes: filtered, count: filtered.length };
	});
}

const LIST_PREVIEW_BATCH = 50;

// These fields map onto IMAP SEARCH keys. Body text stays on the parsed path
// so the match stays the decoded text and HTML, not whatever IMAP BODY returns.
const SERVER_SEARCH_FIELDS = new Set([
	"subject",
	"from",
	"to",
	"cc",
	"bcc",
	"messageid",
	"message-id",
]);

type StructureNode = {
	type?: string;
	disposition?: string;
	parameters?: Record<string, string>;
	dispositionParameters?: Record<string, string>;
	childNodes?: StructureNode[];
};

type EnvelopeAddress = { name?: string; address?: string };

type ListFetch = {
	uid?: number;
	size?: number;
	envelope?: {
		date?: Date | string;
		subject?: string;
		messageId?: string;
		from?: EnvelopeAddress[];
		to?: EnvelopeAddress[];
		cc?: EnvelopeAddress[];
		bcc?: EnvelopeAddress[];
	};
	bodyStructure?: StructureNode;
	headers?: Buffer;
	source?: Buffer;
};

function listSearchFields(searchFields?: string[]): string[] {
	return (
		searchFields?.length ? searchFields : ["subject", "from", "messageId", "attachments"]
	).map((field) => field.toLowerCase());
}

function serverSearchCriteria(
	fields: string[],
	query: string,
): Record<string, unknown> | undefined {
	const clauses: Record<string, unknown>[] = [];
	for (const field of fields) {
		if (!SERVER_SEARCH_FIELDS.has(field)) continue;
		if (field === "subject") clauses.push({ subject: query });
		else if (field === "from") clauses.push({ from: query });
		else if (field === "to") clauses.push({ to: query });
		else if (field === "cc") clauses.push({ cc: query });
		else if (field === "bcc") clauses.push({ bcc: query });
		else if (field === "messageid" || field === "message-id")
			clauses.push({ header: { "Message-ID": query } });
	}
	if (clauses.length === 0) return undefined;
	if (clauses.length === 1) return clauses[0];
	return { or: clauses };
}

function formatAddressList(addresses?: EnvelopeAddress[]): string | undefined {
	if (!addresses?.length) return undefined;
	const text = addresses
		.map((entry) => {
			const address = entry.address?.trim();
			const name = entry.name?.trim();
			if (name && address) return `${name} <${address}>`;
			return address || name || "";
		})
		.filter(Boolean)
		.join(", ");
	return text || undefined;
}

function attachmentFilename(node: StructureNode): string | undefined {
	return node.dispositionParameters?.filename || node.parameters?.name || undefined;
}

const TEXT_PARTS = new Set(["text/plain", "text/html", "message/delivery-status"]);

// mailparser lists a part when it is not an inline text body. Inline text/plain
// and text/html stay body text, even with a filename. Any other type is an
// attachment, as is a text part whose disposition is not inline. An attached
// message/rfc822 is one attachment; files inside it are not listed again.
// Previews omit attachment size because BODYSTRUCTURE reports the encoded size.
function attachmentsFromStructure(node?: StructureNode): MessageAttachmentInfo[] {
	if (!node) return [];
	if ((node.type ?? "").startsWith("multipart/"))
		return (node.childNodes ?? []).flatMap((child) => attachmentsFromStructure(child));
	const filename = attachmentFilename(node);
	const disposition = node.disposition?.toLowerCase();
	const type = (node.type ?? "").toLowerCase();
	const listed = (disposition !== undefined && disposition !== "inline") || !TEXT_PARTS.has(type);
	if (!listed) return (node.childNodes ?? []).flatMap((child) => attachmentsFromStructure(child));
	return [{ filename: filename || "attachment", content_type: type || undefined }];
}

function envelopeDate(value: Date | string | undefined): string | undefined {
	const date =
		value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
	if (!date || Number.isNaN(date.getTime())) return undefined;
	return date.toISOString();
}

function messageFromEnvelope(uid: string, fetched: ListFetch): MessageInfo {
	const envelope = fetched.envelope;
	const date = envelopeDate(envelope?.date);
	const attachments = attachmentsFromStructure(fetched.bodyStructure);
	return {
		uid,
		message_id: envelope?.messageId?.trim() || undefined,
		from: formatAddressList(envelope?.from),
		subject: envelope?.subject?.trim() || undefined,
		date,
		attachments,
		attachment_count: attachments.length,
		raw_size: fetched.size,
	};
}

function headerBlob(headers: Buffer): Promise<string> {
	return simpleParser(Buffer.concat([headers, Buffer.from("\r\n\r\n")])).then((parsed) =>
		[...parsed.headers.entries()]
			.map(([name, value]) => `${name}: ${toStringValue(value)}`)
			.join("\n"),
	);
}

async function fetchListed(
	client: ImapFlow,
	uids: string[],
	query: {
		envelope?: boolean;
		bodyStructure?: boolean;
		size?: boolean;
		headers?: boolean;
		source?: boolean;
	},
): Promise<Map<string, ListFetch>> {
	const found = new Map<string, ListFetch>();
	if (uids.length === 0) return found;
	for await (const message of client.fetch(uids.join(","), query, { uid: true })) {
		found.set(String(message.uid), message as ListFetch);
	}
	return found;
}

export async function protonBridgeListMessages(
	config: ProtonBridgeConfig,
	mailbox: string | undefined,
	period?: string,
	query?: string,
	unseenOnly = false,
	limit = 20,
	attachmentsOnly = false,
	searchFields?: string[],
	options?: BridgeCallOptions,
): Promise<MessageListResult> {
	if (!config.username || !config.password)
		throw new Error("Missing Proton Bridge username/password.");
	const selectedMailbox = mailbox || config.defaultMailbox;
	if (!selectedMailbox)
		throw new Error("No mailbox provided and PROTON_BRIDGE_DEFAULT_MAILBOX is not set.");
	validateSearchFields(searchFields);
	assertPositiveInteger(limit, "message limit");
	const fields = listSearchFields(searchFields);
	const fieldSet = new Set(fields);
	const needle = query?.trim().toLowerCase() ?? "";
	const serverCriteria = needle ? serverSearchCriteria(fields, needle) : undefined;
	const scansAttachments = Boolean(needle) && fieldSet.has("attachments");
	const scansHeaders = Boolean(needle) && fieldSet.has("headers");
	const scansBody = Boolean(needle) && fieldSet.has("body");
	const scansLocally = scansAttachments || scansHeaders || scansBody;
	return withImap(config, options, async (client) => {
		const eligible =
			!needle || scansLocally ? await searchUids(client, selectedMailbox, period, unseenOnly) : [];
		const serverMatched = new Set<string>();
		if (serverCriteria) {
			for (const uid of await searchUids(
				client,
				selectedMailbox,
				period,
				unseenOnly,
				true,
				serverCriteria,
			))
				serverMatched.add(uid);
		}
		const pool = needle && serverCriteria && !scansLocally ? [...serverMatched] : eligible;
		const ordered = pool
			.map((uid) => Number(uid))
			.filter((uid) => Number.isInteger(uid) && uid > 0)
			.sort((left, right) => right - left)
			.map((uid) => String(uid));
		const messages: MessageInfo[] = [];
		for (let index = 0; index < ordered.length && messages.length < limit; ) {
			throwIfAborted(options?.signal);
			const room = limit - messages.length;
			const exactPreview = (!needle || !scansLocally) && !attachmentsOnly;
			const count = exactPreview ? Math.min(LIST_PREVIEW_BATCH, room) : LIST_PREVIEW_BATCH;
			if (count < 1) break;
			const batch = ordered.slice(index, index + count);
			if (batch.length === 0) break;
			index += batch.length;
			const needsSource = (uid: string) => scansBody && !serverMatched.has(uid);
			const headerUids = scansHeaders
				? batch.filter((uid) => !serverMatched.has(uid) && !needsSource(uid))
				: [];
			const previewUids = batch.filter((uid) => !needsSource(uid) && !headerUids.includes(uid));
			const previews = await fetchListed(client, previewUids, {
				envelope: true,
				bodyStructure: true,
				size: true,
			});
			const headerFetches = await fetchListed(client, headerUids, {
				envelope: true,
				bodyStructure: true,
				size: true,
				headers: true,
			});
			for (const uid of batch) {
				throwIfAborted(options?.signal);
				const known = !needle || serverMatched.has(uid);
				let summary: MessageInfo | undefined;
				let localMatch = false;
				const preview = previews.get(uid) ?? headerFetches.get(uid);
				if (preview) {
					summary = messageFromEnvelope(uid, preview);
					if (scansAttachments)
						localMatch = summary.attachments.some((attachment) =>
							attachment.filename.toLowerCase().includes(needle),
						);
					if (!localMatch && scansHeaders && preview.headers) {
						const headers = await headerBlob(preview.headers);
						localMatch = headers.toLowerCase().includes(needle);
					}
				}
				if (needsSource(uid)) {
					const fetched = await fetchListed(client, [uid], { source: true });
					const source = fetched.get(uid)?.source;
					if (source) {
						const raw = Buffer.isBuffer(source) ? source : Buffer.from(source);
						const parsed = await simpleParser(raw);
						summary = messageFromParsed(uid, parsed, raw.length);
						localMatch = matchesQuery(
							summary,
							parsed,
							needle,
							[...fieldSet].filter(
								(field) => field === "body" || field === "headers" || field === "attachments",
							),
						);
					}
				}
				if (!summary) continue;
				if (!known && !localMatch) continue;
				if (attachmentsOnly && !summary.attachment_count) continue;
				messages.push(summary);
				if (messages.length >= limit) break;
			}
		}
		return { mailbox: selectedMailbox, count: messages.length, messages };
	});
}

export async function protonBridgeGetMessage(
	config: ProtonBridgeConfig,
	options: GetMessageOptions & BridgeCallOptions,
): Promise<GetMessageResult> {
	requireBridgeCredentials(config);
	return withImap(config, options, async (client) => {
		assertUid(options.uid);
		await openMailbox(client, options.mailbox, true);
		const { parsed, source } = await fetchParsedMessage(client, options.uid);
		const summary = messageFromParsed(options.uid, parsed, source.length);
		return {
			...summary,
			mailbox: options.mailbox,
			to: addressText(parsed.to),
			cc: addressText(parsed.cc),
			bcc: addressText(parsed.bcc),
			text_body: options.includeBody === false ? undefined : parsed.text?.trim() || undefined,
			html_body:
				options.includeBody === false || typeof parsed.html !== "string"
					? undefined
					: parsed.html.trim() || undefined,
			headers: options.includeHeaders === false ? undefined : headersFromParsed(parsed),
		};
	});
}

export async function protonBridgeCreateDraft(
	config: ProtonBridgeConfig,
	options: CreateDraftOptions & BridgeCallOptions,
): Promise<CreateDraftResult> {
	requireBridgeCredentials(config);
	const mailbox = options.draftsMailbox?.trim() || "Drafts";
	const raw = await buildMimeMessage(options, true);
	return withImap(config, options, async (client) => {
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
	});
}

export async function protonBridgeSendMessage(
	config: ProtonBridgeConfig,
	options: SendMessageOptions & BridgeCallOptions,
): Promise<SendMessageResult> {
	requireBridgeCredentials(config);
	throwIfAborted(options.signal);
	const labels = [...new Set((options.labels ?? []).map((label) => label.trim()).filter(Boolean))];
	if (labels.length > 0 && !options.saveToMailbox?.trim())
		throw new Error(
			"Applying labels to sent mail requires saveToMailbox so the saved UID can be labeled.",
		);
	const raw = await buildMimeMessage(options);
	throwIfAborted(options.signal);
	const smtp = createSmtpTransport(config, resolveTimeouts(options), options.signal);
	const onAbort = () => {
		smtp.destroy();
	};
	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort);

	let messageId = messageIdFromRaw(raw);
	try {
		const info = await new Promise<Awaited<ReturnType<typeof smtp.transport.sendMail>>>(
			(resolve, reject) => {
				if (options.signal?.aborted) {
					reject(cancelledError());
					return;
				}
				smtp.transport
					.sendMail({
						envelope: {
							from: options.from,
							to: allRecipients(options),
						},
						raw,
					})
					.then(
						(result) => {
							if (options.signal?.aborted) reject(cancelledError());
							else resolve(result);
						},
						(error: unknown) => {
							if (options.signal?.aborted) reject(cancelledError());
							else reject(error instanceof Error ? error : new Error(String(error)));
						},
					);
			},
		);
		if (typeof info.messageId === "string") messageId = info.messageId;
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		if (options.signal?.aborted) smtp.destroy();
		else smtp.transport.close();
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
		const appendResult = await withImap(config, options, (client) =>
			client.append(saveToMailbox, raw, ["\\Seen"], new Date()),
		);
		result.saved_to_mailbox = saveToMailbox;
		result.saved_uid = appendUid(appendResult);
	}

	if (labels.length > 0) {
		if (!result.saved_to_mailbox || !result.saved_uid)
			throw new Error(
				"Proton Bridge did not return a UID for the saved sent copy; labels were not applied.",
			);
		const labelResult = await protonBridgeApplyLabels(config, {
			mailbox: result.saved_to_mailbox,
			uid: result.saved_uid,
			labels,
			signal: options.signal,
			timeouts: options.timeouts,
		});
		result.labels = labelResult.labels;
		result.label_mailboxes = labelResult.label_mailboxes;
	}

	return result;
}

export async function protonBridgeMoveMessage(
	config: ProtonBridgeConfig,
	options: MoveMessageOptions & BridgeCallOptions,
): Promise<MoveMessageResult> {
	requireBridgeCredentials(config);
	return withImap(config, options, async (client) => {
		await openMailbox(client, options.mailbox, false);
		await assertUidExists(client, options.mailbox, options.uid);
		const result = await client.messageMove(options.uid, options.destination, { uid: true });
		assertWriteResult(result, "move", options.uid, options.destination);
		return {
			uid: options.uid,
			source: options.mailbox,
			destination: options.destination,
		};
	});
}

export async function protonBridgeCopyMessage(
	config: ProtonBridgeConfig,
	options: CopyMessageOptions & BridgeCallOptions,
): Promise<CopyMessageResult> {
	requireBridgeCredentials(config);
	return withImap(config, options, async (client) => {
		await openMailbox(client, options.mailbox, false);
		await assertUidExists(client, options.mailbox, options.uid);
		const result = await client.messageCopy(options.uid, options.destination, { uid: true });
		assertWriteResult(result, "copy", options.uid, options.destination);
		return {
			uid: options.uid,
			source: options.mailbox,
			destination: options.destination,
			copied_uid: copyUid(result, options.uid),
		};
	});
}

export async function protonBridgeApplyLabels(
	config: ProtonBridgeConfig,
	options: ApplyLabelsOptions & BridgeCallOptions,
): Promise<ApplyLabelsResult> {
	requireBridgeCredentials(config);
	const labels = [...new Set(options.labels.map((label) => label.trim()).filter(Boolean))];
	if (labels.length === 0) throw new Error("At least one label is required.");
	return withImap(config, options, async (client) => {
		const mailboxes = await listMailboxes(client);
		await openMailbox(client, options.mailbox, false);
		await assertUidExists(client, options.mailbox, options.uid);
		const labelMailboxes = [
			...new Set(labels.map((label) => resolveLabelMailbox(label, mailboxes))),
		];
		for (const labelMailbox of labelMailboxes) {
			throwIfAborted(options.signal);
			const result = await client.messageCopy(options.uid, labelMailbox, { uid: true });
			assertWriteResult(result, "label", options.uid, labelMailbox);
		}
		return {
			uid: options.uid,
			mailbox: options.mailbox,
			labels,
			label_mailboxes: labelMailboxes,
		};
	});
}

export async function protonBridgeImportAttachments(
	config: ProtonBridgeConfig,
	options: ImportOptions & BridgeCallOptions,
): Promise<ProtonBridgeImportResult> {
	if (!config.username || !config.password)
		throw new Error("Missing Proton Bridge username/password.");
	const selectedMailbox = options.mailbox || config.defaultMailbox;
	if (!selectedMailbox)
		throw new Error("No mailbox provided and PROTON_BRIDGE_DEFAULT_MAILBOX is not set.");
	if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(options.period))
		throw new Error(`Invalid period '${options.period}'. Expected YYYY-MM.`);

	const workspaceRoot = options.workspaceRoot.trim();
	const baseRoot = resolve(options.cwd, workspaceRoot);
	const relativeRoot = relative(options.cwd, baseRoot);
	if (isAbsolute(workspaceRoot) || relativeRoot.startsWith("..") || isAbsolute(relativeRoot))
		throw new Error(
			`Import workspace root "${workspaceRoot}" must be a relative path inside the project directory.`,
		);
	const periodRoot = join(baseRoot, options.period);
	const mailRoot = join(periodRoot, "_mail", sanitizePathSegment(selectedMailbox));
	const inboxRoot = join(periodRoot, "_inbox");
	await ensureDir(mailRoot);
	await ensureDir(inboxRoot);

	const importedMessages: ProtonBridgeImportResult["messages"] = [];
	let importedAttachmentCount = 0;
	return withImap(config, options, async (client) => {
		const uids = await searchUids(
			client,
			selectedMailbox,
			options.period,
			options.unseenOnly,
			!options.markSeen,
		);
		// Scan the whole period (like listing) so older matches are not silently skipped.
		for (const uid of [...uids].reverse()) {
			throwIfAborted(options.signal);
			const { parsed, source } = await fetchParsedMessage(client, uid);
			const summary = messageFromParsed(uid, parsed, source.length);
			if (summary.attachment_count === 0) continue;
			if (!matchesQuery(summary, parsed, options.query)) continue;

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
	});
}
