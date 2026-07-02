import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface ProtonBridgeConfig {
	host: string;
	imapPort: number;
	smtpPort: number;
	username?: string;
	password?: string;
	security: string;
	defaultMailbox?: string;
}

export interface ProtonMailProfilePolicy {
	default_mailbox?: string;
	mailbox_filter?: string;
	default_period?: string;
	import_workspace_root?: string;
	default_from?: string;
}

export interface ProtonMailWorkspaceConfig {
	activeProfile?: string;
}

export interface ProtonMailWorkingProfile {
	profile: string;
	policy: ProtonMailProfilePolicy;
	policyPath: string;
}

export interface BridgeStatusResult {
	config: {
		host: string;
		imap_port: number;
		smtp_port: number;
		security: string;
		default_mailbox?: string;
		username_set: boolean;
		password_set: boolean;
	};
	imap: { open: boolean; banner?: string; error?: string };
	smtp: { open: boolean; banner?: string; error?: string };
	login?: {
		ok: boolean;
		mailbox_count?: number;
		mailboxes?: Array<{ name: string }>;
		error?: string;
	};
}

export interface MailboxInfo {
	name: string;
	raw?: string;
	flags?: string[];
	delimiter?: string | null;
}

export interface MessageAttachmentInfo {
	filename: string;
	content_type?: string;
	size?: number;
}

export interface MessageInfo {
	uid: string;
	message_id?: string;
	from?: string;
	subject?: string;
	date?: string;
	attachments: MessageAttachmentInfo[];
	attachment_count: number;
	raw_size?: number;
}

export interface MailboxListResult {
	mailboxes: MailboxInfo[];
	count: number;
}

export interface MessageListResult {
	mailbox: string;
	count: number;
	messages: MessageInfo[];
}

export interface CreateDraftResult {
	mailbox: string;
	uid?: string;
	from: string;
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	attachment_count: number;
}

export interface SendMessageResult {
	from: string;
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	attachment_count: number;
	message_id?: string;
	saved_to_mailbox?: string;
	saved_uid?: string;
}

export interface MoveMessageResult {
	uid: string;
	source: string;
	destination: string;
}

export type CommandContext = Pick<ExtensionCommandContext, "cwd" | "hasUI" | "ui">;

export interface ToolContext {
	cwd: string;
	signal?: AbortSignal;
}
