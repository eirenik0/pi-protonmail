import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-tui";
import {
	type Component,
	Container,
	type Focusable,
	Input,
	Markdown,
	matchesKey,
	SelectList,
	Spacer,
	Text,
	visibleWidth,
} from "@earendil-works/pi-tui";

import type {
	BridgeStatusResult,
	MailboxListResult,
	MessageInfo,
	MessageListResult,
} from "./types.ts";

export interface ProtonMailHubLoaders {
	status(cwd: string): Promise<BridgeStatusResult>;
	mailboxes(cwd: string): Promise<MailboxListResult>;
	messages(cwd: string, mailbox: string, period: string): Promise<MessageListResult>;
}

export interface ProtonMailHubArgs {
	mailbox?: string;
	period?: string;
}

const MONTH_RE = /^\d{4}-\d{2}$/;

function currentMonth(): string {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	return `${now.getFullYear()}-${month}`;
}

function parseHubArgs(raw: string): ProtonMailHubArgs {
	const parts = raw.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return {};
	const last = parts.at(-1);
	const period = last && MONTH_RE.test(last) ? last : undefined;
	const mailbox = (period ? parts.slice(0, -1) : parts).join(" ").trim() || undefined;
	return { mailbox, period };
}

function selectTheme(theme: Theme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", theme.bold(text)),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("dim", text),
	};
}

function statusMarkdown(result?: BridgeStatusResult, error?: string): string {
	if (error) {
		return `# Proton Mail Bridge\n\n- ${error}`;
	}
	if (!result) return "# Proton Mail Bridge\n\nLoading status…";
	const lines = [
		"# Proton Mail Bridge",
		"",
		`- Host: \`${result.config.host}\``,
		`- IMAP: \`${result.config.imap_port}\` (${result.imap.open ? "open" : "closed"})`,
		`- SMTP: \`${result.config.smtp_port}\` (${result.smtp.open ? "open" : "closed"})`,
		`- Security: \`${result.config.security}\``,
		`- Default mailbox: ${result.config.default_mailbox ? `\`${result.config.default_mailbox}\`` : "—"}`,
		`- Credentials: ${result.config.username_set && result.config.password_set ? "configured" : "missing"}`,
	];
	if (result.login) {
		lines.push(
			"",
			"## Login",
			result.login.ok
				? `- ok • ${result.login.mailbox_count ?? 0} mailboxes visible`
				: `- failed • ${result.login.error ?? "unknown error"}`,
		);
	}
	return lines.join("\n");
}

function mailboxLabel(mailbox: { name: string; flags?: string[]; raw?: string }) {
	const flags = mailbox.flags?.length ? ` (${mailbox.flags.join(", ")})` : "";
	return `${mailbox.name}${flags}`;
}

function messageLabel(message: MessageInfo) {
	return `${message.subject ?? "(no subject)"} — ${message.from ?? "unknown sender"}`;
}

function messageDescription(message: MessageInfo) {
	const attachments = message.attachments.length
		? `${message.attachments.length} attachment(s)`
		: "no attachments";
	return `${message.date ?? "unknown date"} • ${attachments} • UID ${message.uid}`;
}

function messageMarkdown(message?: MessageInfo, mailbox?: string, period?: string): string {
	if (!message) {
		return [
			"# Message detail",
			"",
			`Select a message in ${mailbox ?? "the current mailbox"}${period ? ` for ${period}` : ""}.`,
		].join("\n");
	}
	const attachments =
		message.attachments.length > 0
			? message.attachments
					.map(
						(attachment) =>
							`- ${attachment.filename}${attachment.size ? ` (${attachment.size} bytes)` : ""}`,
					)
					.join("\n")
			: "- none";
	return [
		"# Message detail",
		"",
		`- UID: \`${message.uid}\``,
		`- From: ${message.from ?? "—"}`,
		`- Subject: ${message.subject ?? "—"}`,
		`- Date: ${message.date ?? "—"}`,
		`- Attachments: ${message.attachment_count}`,
		"",
		"## Attachments",
		attachments,
	].join("\n");
}

function makeSelectItem(value: string, label: string, description?: string) {
	return { value, label, description };
}

function replaceSelectItems<T extends { value: string; label: string; description?: string }>(
	list: SelectList,
	items: T[],
) {
	const mutable = list as SelectList & {
		items: T[];
		filteredItems: T[];
		selectedIndex: number;
	};
	mutable.items = items;
	mutable.filteredItems = items;
	mutable.selectedIndex = items.length > 0 ? 0 : 0;
}

function selectedItemValue(list: SelectList): string | undefined {
	return list.getSelectedItem()?.value;
}

class ProtonMailHubComponent implements Component, Focusable {
	private readonly root = new Container();
	private readonly mdTheme = getMarkdownTheme();
	private readonly mailboxFilterInput = new Input();
	private readonly periodInput = new Input();
	private readonly mailboxList: SelectList;
	private readonly messageList: SelectList;
	private readonly statusText: Markdown;
	private readonly messageText: Markdown;
	private readonly footerText: Text;
	private readonly theme: Theme;
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.updateFocusState();
	}
	private focusMode: "mailbox-filter" | "mailboxes" | "period" | "messages" = "mailbox-filter";
	private loadToken = 0;
	private mailboxLoadToken = 0;
	private messageLoadToken = 0;
	private status?: BridgeStatusResult;
	private messages: MessageListResult = { mailbox: "", count: 0, messages: [] };
	private activeMailbox?: string;
	private activePeriod: string;

	constructor(
		private readonly tui: { requestRender(): void },
		theme: Theme,
		private readonly done: (value: null) => void,
		private readonly ctx: Pick<ExtensionCommandContext, "cwd">,
		private readonly loaders: ProtonMailHubLoaders,
		initial: ProtonMailHubArgs,
	) {
		this.theme = theme;
		this.activePeriod = initial.period ?? currentMonth();
		this.statusText = new Markdown(statusMarkdown(), 0, 0, this.mdTheme);
		this.mailboxList = new SelectList([], 6, selectTheme(theme));
		this.messageList = new SelectList([], 8, selectTheme(theme));
		this.messageText = new Markdown(
			messageMarkdown(undefined, undefined, this.activePeriod),
			0,
			0,
			this.mdTheme,
		);
		this.footerText = new Text(
			"Tab cycles • Enter loads/steps forward • Esc clears or exits • Ctrl+C exits • Ctrl+R refreshes",
			0,
			0,
		);

		this.mailboxFilterInput.setValue(initial.mailbox ?? "");
		this.periodInput.setValue(this.activePeriod);
		this.mailboxFilterInput.onSubmit = () => {
			this.focusMode = "mailboxes";
			this.updateFocusState();
			this.refresh();
		};
		this.mailboxFilterInput.onEscape = () => {
			if (this.mailboxFilterInput.getValue()) {
				this.mailboxFilterInput.setValue("");
				this.applyMailboxFilter();
				return;
			}
			this.done(null);
		};
		this.periodInput.onSubmit = () => {
			const next = this.parsePeriod(this.periodInput.getValue()) ?? this.activePeriod;
			this.activePeriod = next;
			this.periodInput.setValue(next);
			void this.loadMessagesForSelection();
			this.focusMode = "messages";
			this.updateFocusState();
			this.refresh();
		};
		this.periodInput.onEscape = () => {
			if (this.periodInput.getValue() !== this.activePeriod) {
				this.periodInput.setValue(this.activePeriod);
				return;
			}
			this.focusMode = "mailboxes";
			this.updateFocusState();
			this.refresh();
		};

		this.mailboxList.onSelectionChange = (item) => {
			this.activeMailbox = item.value;
			void this.loadMessagesForSelection();
		};
		this.mailboxList.onSelect = (item) => {
			this.activeMailbox = item.value;
			this.focusMode = "period";
			this.updateFocusState();
			void this.loadMessagesForSelection();
		};
		this.mailboxList.onCancel = () => {
			this.focusMode = "mailbox-filter";
			this.updateFocusState();
			this.refresh();
		};

		this.messageList.onSelectionChange = (item) => {
			const selected = this.messages.messages.find((message) => message.uid === item.value);
			this.messageText.setText(messageMarkdown(selected, this.activeMailbox, this.activePeriod));
			this.refresh();
		};
		this.messageList.onSelect = () => {
			this.focusMode = "messages";
			this.updateFocusState();
			this.refresh();
		};
		this.messageList.onCancel = () => {
			this.focusMode = "period";
			this.updateFocusState();
			this.refresh();
		};

		this.root.addChild(new Text("Proton Mail TUI", 0, 0));
		this.root.addChild(new Spacer(1));
		this.root.addChild(this.statusText);
		this.root.addChild(new Spacer(1));
		this.root.addChild(new Text("Mailbox filter", 0, 0));
		this.root.addChild(this.mailboxFilterInput);
		this.root.addChild(this.mailboxList);
		this.root.addChild(new Spacer(1));
		this.root.addChild(new Text("Period (YYYY-MM)", 0, 0));
		this.root.addChild(this.periodInput);
		this.root.addChild(new Spacer(1));
		this.root.addChild(new Text("Messages", 0, 0));
		this.root.addChild(this.messageList);
		this.root.addChild(new Spacer(1));
		this.root.addChild(this.messageText);
		this.root.addChild(new Spacer(1));
		this.root.addChild(this.footerText);

		this.updateFocusState();
		void this.bootstrap(initial.mailbox);
	}

	private refresh(): void {
		this.tui.requestRender();
	}

	private updateFocusState(): void {
		const active = this._focused;
		this.mailboxFilterInput.focused = active && this.focusMode === "mailbox-filter";
		this.periodInput.focused = active && this.focusMode === "period";
	}

	private parsePeriod(value: string): string | undefined {
		const trimmed = value.trim();
		return /^\d{4}-\d{2}$/.test(trimmed) ? trimmed : undefined;
	}

	private applyMailboxFilter(): void {
		const filter = this.mailboxFilterInput.getValue().trim().toLowerCase();
		this.mailboxList.setFilter(filter);
		this.activeMailbox = selectedItemValue(this.mailboxList);
		void this.loadMessagesForSelection();
		this.refresh();
	}

	private setMailboxItems(result: MailboxListResult): void {
		replaceSelectItems(
			this.mailboxList,
			result.mailboxes.map((mailbox) =>
				makeSelectItem(
					mailbox.name,
					mailboxLabel(mailbox),
					mailbox.flags?.length ? mailbox.flags.join(", ") : mailbox.raw,
				),
			),
		);
		this.mailboxList.setFilter(this.mailboxFilterInput.getValue().trim().toLowerCase());
		this.activeMailbox = selectedItemValue(this.mailboxList) ?? this.activeMailbox;
		this.refresh();
	}

	private setMessageItems(result: MessageListResult): void {
		this.messages = result;
		replaceSelectItems(
			this.messageList,
			result.messages.map((message) =>
				makeSelectItem(message.uid, messageLabel(message), messageDescription(message)),
			),
		);
		const selected = this.messageList.getSelectedItem();
		this.messageText.setText(
			messageMarkdown(
				selected
					? this.messages.messages.find((message) => message.uid === selected.value)
					: undefined,
				this.activeMailbox,
				this.activePeriod,
			),
		);
		this.refresh();
	}

	private async bootstrap(initialMailbox?: string): Promise<void> {
		const token = ++this.loadToken;
		try {
			this.statusText.setText("# Proton Mail Bridge\n\nLoading status…");
			this.status = await this.loaders.status(this.ctx.cwd);
			if (token !== this.loadToken) return;
			this.statusText.setText(statusMarkdown(this.status));
		} catch (error) {
			if (token !== this.loadToken) return;
			const statusError = error instanceof Error ? error.message : String(error);
			this.statusText.setText(statusMarkdown(undefined, statusError));
		}

		try {
			const mailboxToken = ++this.mailboxLoadToken;
			const mailboxes = await this.loaders.mailboxes(this.ctx.cwd);
			if (mailboxToken !== this.mailboxLoadToken) return;
			this.setMailboxItems(mailboxes);
			const preferred =
				initialMailbox && mailboxes.mailboxes.some((mailbox) => mailbox.name === initialMailbox)
					? initialMailbox
					: this.status?.config.default_mailbox &&
							mailboxes.mailboxes.some(
								(mailbox) => mailbox.name === this.status?.config.default_mailbox,
							)
						? this.status?.config.default_mailbox
						: mailboxes.mailboxes[0]?.name;
			if (preferred) {
				this.activeMailbox = preferred;
				this.mailboxList.setSelectedIndex(
					mailboxes.mailboxes.findIndex((mailbox) => mailbox.name === preferred),
				);
			}
			if (initialMailbox) {
				this.applyMailboxFilter();
				if (!selectedItemValue(this.mailboxList) && preferred) {
					this.activeMailbox = preferred;
					this.mailboxList.setSelectedIndex(
						mailboxes.mailboxes.findIndex((mailbox) => mailbox.name === preferred),
					);
					void this.loadMessagesForSelection();
				}
			} else {
				void this.loadMessagesForSelection();
			}
		} catch (error) {
			if (token !== this.loadToken) return;
			this.statusText.setText(
				statusMarkdown(this.status, error instanceof Error ? error.message : String(error)),
			);
			this.messageText.setText(messageMarkdown(undefined, this.activeMailbox, this.activePeriod));
		}
	}

	private async loadMessagesForSelection(): Promise<void> {
		const mailbox = this.activeMailbox ?? selectedItemValue(this.mailboxList);
		const period = this.parsePeriod(this.periodInput.getValue()) ?? this.activePeriod;
		this.activePeriod = period;
		this.periodInput.setValue(period);
		if (!mailbox) {
			replaceSelectItems(this.messageList, []);
			this.messageText.setText(messageMarkdown(undefined, undefined, period));
			this.refresh();
			return;
		}
		const token = ++this.messageLoadToken;
		try {
			const result = await this.loaders.messages(this.ctx.cwd, mailbox, period);
			if (token !== this.messageLoadToken) return;
			this.setMessageItems(result);
		} catch (error) {
			if (token !== this.messageLoadToken) return;
			this.messages = { mailbox, count: 0, messages: [] };
			replaceSelectItems(this.messageList, []);
			this.messageText.setText(
				messageMarkdown(undefined, mailbox, period) +
					`\n\n> ${error instanceof Error ? error.message : String(error)}`,
			);
			this.refresh();
		}
	}

	invalidate(): void {
		this.root.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.focusMode === "mailbox-filter") {
				if (this.mailboxFilterInput.getValue()) {
					this.mailboxFilterInput.setValue("");
					this.applyMailboxFilter();
					return;
				}
				this.done(null);
				return;
			}
			if (this.focusMode === "period") {
				if (this.periodInput.getValue() !== this.activePeriod) {
					this.periodInput.setValue(this.activePeriod);
					return;
				}
				this.focusMode = "mailboxes";
				this.updateFocusState();
				this.refresh();
				return;
			}
			if (this.focusMode === "messages") {
				this.focusMode = "period";
				this.updateFocusState();
				this.refresh();
				return;
			}
			this.focusMode = "mailbox-filter";
			this.updateFocusState();
			this.refresh();
			return;
		}
		if (matchesKey(data, "tab")) {
			if (this.focusMode === "mailbox-filter") this.focusMode = "mailboxes";
			else if (this.focusMode === "mailboxes") this.focusMode = "period";
			else if (this.focusMode === "period") this.focusMode = "messages";
			else this.focusMode = "mailbox-filter";
			this.updateFocusState();
			this.refresh();
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			void this.bootstrap(this.activeMailbox);
			return;
		}

		if (this.focusMode === "mailbox-filter") {
			this.mailboxFilterInput.handleInput(data);
			this.applyMailboxFilter();
			return;
		}
		if (this.focusMode === "period") {
			this.periodInput.handleInput(data);
			return;
		}
		if (this.focusMode === "mailboxes") {
			this.mailboxList.handleInput(data);
			return;
		}
		this.messageList.handleInput(data);
	}

	render(width: number): string[] {
		const innerWidth = Math.max(30, width - 2);
		const border = (value: string) => this.theme.fg("border", value);
		const padLine = (content: string) => {
			const pad = Math.max(0, innerWidth - visibleWidth(content));
			return `${border("│")}${content}${" ".repeat(pad)}${border("│")}`;
		};
		const section = (title: string) => [
			border(`├${"─".repeat(innerWidth)}┤`),
			padLine(this.theme.fg("accent", ` ${title}`)),
		];
		const lines: string[] = [border(`╭${"─".repeat(innerWidth)}╮`)];
		lines.push(padLine(this.theme.fg("accent", " Proton Mail TUI")));
		lines.push(
			padLine(
				this.theme.fg(
					"dim",
					" Mailbox filter • period • messages • Tab cycles • Enter loads • Esc backs out • Ctrl+C exits • Ctrl+R refreshes",
				),
			),
		);
		lines.push(...section("Bridge status"));
		for (const line of this.statusText.render(innerWidth)) lines.push(padLine(line));
		lines.push(...section("Mailbox filter"));
		for (const line of this.mailboxFilterInput.render(innerWidth)) lines.push(padLine(line));
		lines.push(...section("Mailboxes"));
		for (const line of this.mailboxList.render(innerWidth)) lines.push(padLine(line));
		lines.push(...section("Period (YYYY-MM)"));
		for (const line of this.periodInput.render(innerWidth)) lines.push(padLine(line));
		lines.push(...section("Messages"));
		for (const line of this.messageList.render(innerWidth)) lines.push(padLine(line));
		lines.push(...section("Message detail"));
		for (const line of this.messageText.render(innerWidth)) lines.push(padLine(line));
		lines.push(...section("Status"));
		lines.push(
			padLine(
				this.theme.fg(
					"dim",
					` Focus: ${this.focusMode} • Mailbox: ${this.activeMailbox ?? "—"} • Period: ${this.activePeriod}`,
				),
			),
		);
		for (const line of this.footerText.render(innerWidth)) lines.push(padLine(line));
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}
}

export async function openProtonMailHub(
	ctx: Pick<ExtensionCommandContext, "cwd" | "hasUI" | "ui">,
	loaders: ProtonMailHubLoaders,
	rawArgs: string,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Proton Mail TUI requires interactive mode.", "warning");
		return;
	}
	const args = parseHubArgs(rawArgs);
	await ctx.ui.custom(
		(tui, theme, _keybindings, done) =>
			new ProtonMailHubComponent(tui, theme, done, ctx, loaders, args),
		{ overlay: true, overlayOptions: { width: "92%", maxHeight: "92%" } },
	);
}
