import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-tui";
import {
	type Component,
	type Focusable,
	Input,
	Markdown,
	matchesKey,
	SelectList,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

import type { ProtonMailProfilePolicy, ProtonMailWorkingProfile } from "./types.ts";

export type ProtonMailHubResult =
	| {
			kind: "save";
			profile: string;
			policy: ProtonMailProfilePolicy;
	  }
	| {
			kind: "delete";
			profile: string;
	  };

export interface ProtonMailHubArgs {
	profile?: string;
}

const MONTH_RE = /^\d{4}-\d{2}$/;

function currentMonth(): string {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	return `${now.getFullYear()}-${month}`;
}

function parseHubArgs(raw: string): ProtonMailHubArgs {
	const profile = raw.trim().split(/\s+/).filter(Boolean)[0];
	return { profile: profile || undefined };
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

function policySummary(policy: ProtonMailProfilePolicy): string {
	const parts = [
		policy.default_mailbox ? `mailbox:${policy.default_mailbox}` : "mailbox:—",
		policy.mailbox_filter ? `filter:${policy.mailbox_filter}` : "filter:—",
		policy.default_period ? `period:${policy.default_period}` : "period:current",
	];
	return parts.join(" • ");
}

function profileLabel(profile: ProtonMailWorkingProfile): string {
	return profile.profile;
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

function normalized(text: string): string {
	return text.trim().toLowerCase();
}

class ProtonMailHubComponent implements Component, Focusable {
	private readonly mdTheme = getMarkdownTheme();
	private readonly profileFilterInput = new Input();
	private readonly defaultMailboxInput = new Input();
	private readonly mailboxFilterInput = new Input();
	private readonly periodInput = new Input();
	private readonly profilesList: SelectList;
	private readonly titleText: Markdown;
	private readonly helpText: Markdown;
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
	private focusMode:
		| "profile-filter"
		| "profiles"
		| "default-mailbox"
		| "mailbox-filter"
		| "period" = "profile-filter";
	private profiles: ProtonMailWorkingProfile[];
	private activeProfile: string;
	private errorMessage = "";

	constructor(
		private readonly tui: { requestRender(): void },
		theme: Theme,
		private readonly done: (value: ProtonMailHubResult | null) => void,
		profiles: ProtonMailWorkingProfile[],
		initialProfile?: string,
	) {
		this.theme = theme;
		this.profiles = profiles.length > 0 ? [...profiles] : [this.createSyntheticDefaultProfile()];
		this.activeProfile = this.resolveInitialProfile(initialProfile);
		this.profilesList = new SelectList([], 6, selectTheme(theme));
		this.titleText = new Markdown(
			[
				"# Proton Mail Settings Hub",
				"",
				"Configure profiles for later LLM workflows instead of browsing mail here.",
			].join("\n"),
			0,
			0,
			this.mdTheme,
		);
		this.helpText = new Markdown(
			[
				"# What this saves",
				"",
				"- active profile",
				"- default mailbox",
				"- mailbox filter",
				"- default period",
			].join("\n"),
			0,
			0,
			this.mdTheme,
		);
		this.footerText = new Text(
			"Tab cycles • Enter creates/saves • Ctrl+S saves • Ctrl+D deletes • Esc clears/back",
			0,
			0,
		);

		this.profileFilterInput.setValue(initialProfile ?? this.activeProfile);
		this.loadProfileIntoInputs(this.currentProfile());

		this.profileFilterInput.onSubmit = () => {
			const next = this.profileFilterInput.getValue().trim();
			if (!next) {
				this.focusMode = "profiles";
				this.updateFocusState();
				this.refresh();
				return;
			}
			this.selectOrCreateProfile(next);
			this.focusMode = "default-mailbox";
			this.updateFocusState();
			this.refresh();
		};
		this.profileFilterInput.onEscape = () => {
			if (this.profileFilterInput.getValue()) {
				this.profileFilterInput.setValue("");
				this.applyProfileFilter();
				return;
			}
			this.done(null);
		};

		this.defaultMailboxInput.onSubmit = () => {
			this.focusMode = "mailbox-filter";
			this.updateFocusState();
			this.refresh();
		};
		this.defaultMailboxInput.onEscape = () => {
			if (this.defaultMailboxInput.getValue() !== this.currentPolicy().default_mailbox) {
				this.defaultMailboxInput.setValue(this.currentPolicy().default_mailbox ?? "");
				return;
			}
			this.focusMode = "profiles";
			this.updateFocusState();
			this.refresh();
		};

		this.mailboxFilterInput.onSubmit = () => {
			this.focusMode = "period";
			this.updateFocusState();
			this.refresh();
		};
		this.mailboxFilterInput.onEscape = () => {
			if (this.mailboxFilterInput.getValue() !== this.currentPolicy().mailbox_filter) {
				this.mailboxFilterInput.setValue(this.currentPolicy().mailbox_filter ?? "");
				return;
			}
			this.focusMode = "default-mailbox";
			this.updateFocusState();
			this.refresh();
		};

		this.periodInput.onSubmit = () => {
			this.saveCurrentProfile();
		};
		this.periodInput.onEscape = () => {
			if (this.periodInput.getValue() !== this.currentPolicy().default_period) {
				this.periodInput.setValue(this.currentPolicy().default_period ?? currentMonth());
				return;
			}
			this.focusMode = "mailbox-filter";
			this.updateFocusState();
			this.refresh();
		};

		this.profilesList.onSelectionChange = (item) => {
			this.selectProfile(item.value);
		};
		this.profilesList.onSelect = (item) => {
			this.selectProfile(item.value);
			this.focusMode = "default-mailbox";
			this.updateFocusState();
			this.refresh();
		};
		this.profilesList.onCancel = () => {
			this.focusMode = "profile-filter";
			this.updateFocusState();
			this.refresh();
		};

		this.applyProfileFilter();
		this.updateFocusState();
	}

	private createSyntheticDefaultProfile(): ProtonMailWorkingProfile {
		return {
			profile: "default",
			policy: {},
			policyPath: ".pi/protonmail/profiles/default/policy.json",
		};
	}

	private resolveInitialProfile(initialProfile?: string): string {
		if (initialProfile?.trim()) {
			const normalizedInitial = normalized(initialProfile);
			if (this.profiles.some((profile) => profile.profile === normalizedInitial))
				return normalizedInitial;
			return normalizedInitial;
		}
		return this.profiles[0]?.profile ?? "default";
	}

	private currentProfile(): ProtonMailWorkingProfile {
		return (
			this.profiles.find((profile) => profile.profile === this.activeProfile) ?? this.profiles[0]
		);
	}

	private currentPolicy(): ProtonMailProfilePolicy {
		return this.currentProfile()?.policy ?? {};
	}

	private loadProfileIntoInputs(profile?: ProtonMailWorkingProfile): void {
		const current = profile ?? this.currentProfile();
		this.defaultMailboxInput.setValue(current.policy.default_mailbox ?? "");
		this.mailboxFilterInput.setValue(current.policy.mailbox_filter ?? "");
		this.periodInput.setValue(current.policy.default_period ?? currentMonth());
	}

	private profileMatchesQuery(profile: ProtonMailWorkingProfile, query: string): boolean {
		const needle = normalized(query);
		if (!needle) return true;
		return [
			profile.profile,
			profile.policy.default_mailbox ?? "",
			profile.policy.mailbox_filter ?? "",
			profile.policy.default_period ?? "",
		].some((value) => normalized(value).includes(needle));
	}

	private filteredProfiles(): ProtonMailWorkingProfile[] {
		const query = this.profileFilterInput.getValue().trim();
		if (!query) return this.profiles;
		return this.profiles.filter((profile) => this.profileMatchesQuery(profile, query));
	}

	private applyProfileFilter(): void {
		const filter = this.profileFilterInput.getValue().trim().toLowerCase();
		const visible = this.filteredProfiles();
		replaceSelectItems(
			this.profilesList,
			visible.map((profile) =>
				makeSelectItem(profile.profile, profileLabel(profile), policySummary(profile.policy)),
			),
		);
		this.profilesList.setFilter(filter);
		this.activeProfile = selectedItemValue(this.profilesList) ?? this.activeProfile;
		this.refresh();
	}

	private selectProfile(profileName: string): void {
		const profile = this.profiles.find((entry) => entry.profile === profileName);
		if (!profile) return;
		this.activeProfile = profile.profile;
		this.loadProfileIntoInputs(profile);
		this.applyProfileFilter();
	}

	private selectOrCreateProfile(value: string): void {
		const profileName = normalized(value);
		if (!profileName) return;
		const existing = this.profiles.find((profile) => profile.profile === profileName);
		if (existing) {
			this.selectProfile(existing.profile);
			return;
		}
		const next: ProtonMailWorkingProfile = {
			profile: profileName,
			policy: {},
			policyPath: `.pi/protonmail/profiles/${profileName}/policy.json`,
		};
		this.profiles = [...this.profiles, next].sort((left, right) =>
			left.profile.localeCompare(right.profile),
		);
		this.activeProfile = next.profile;
		this.loadProfileIntoInputs(next);
		this.applyProfileFilter();
	}

	private currentPolicyFromInputs(): ProtonMailProfilePolicy {
		const default_period = this.periodInput.getValue().trim();
		return {
			default_mailbox: this.defaultMailboxInput.getValue().trim() || undefined,
			mailbox_filter: this.mailboxFilterInput.getValue().trim() || undefined,
			default_period: default_period
				? MONTH_RE.test(default_period)
					? default_period
					: undefined
				: undefined,
		};
	}

	private saveCurrentProfile(): void {
		const profile = this.currentProfile();
		if (!profile) return;
		this.done({ kind: "save", profile: profile.profile, policy: this.currentPolicyFromInputs() });
	}

	private deleteCurrentProfile(): void {
		const profile = this.currentProfile();
		if (!profile) return;
		if (profile.profile === "default") {
			this.errorMessage = "The default profile cannot be deleted.";
			this.refresh();
			return;
		}
		this.done({ kind: "delete", profile: profile.profile });
	}

	private refresh(): void {
		this.tui.requestRender();
	}

	private updateFocusState(): void {
		const active = this._focused;
		this.profileFilterInput.focused = active && this.focusMode === "profile-filter";
		this.defaultMailboxInput.focused = active && this.focusMode === "default-mailbox";
		this.mailboxFilterInput.focused = active && this.focusMode === "mailbox-filter";
		this.periodInput.focused = active && this.focusMode === "period";
	}

	invalidate(): void {
		this.profileFilterInput.invalidate();
		this.defaultMailboxInput.invalidate();
		this.mailboxFilterInput.invalidate();
		this.periodInput.invalidate();
		this.profilesList.invalidate();
		this.titleText.invalidate();
		this.helpText.invalidate();
		this.footerText.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "ctrl+s")) {
			this.saveCurrentProfile();
			return;
		}
		if (matchesKey(data, "ctrl+d")) {
			this.deleteCurrentProfile();
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.focusMode === "profile-filter") {
				if (this.profileFilterInput.getValue()) {
					this.profileFilterInput.setValue("");
					this.applyProfileFilter();
					return;
				}
				this.done(null);
				return;
			}
			if (this.focusMode === "period") {
				if (
					this.periodInput.getValue() !== (this.currentPolicy().default_period ?? currentMonth())
				) {
					this.periodInput.setValue(this.currentPolicy().default_period ?? currentMonth());
					return;
				}
				this.focusMode = "mailbox-filter";
				this.updateFocusState();
				this.refresh();
				return;
			}
			if (this.focusMode === "mailbox-filter") {
				if (this.mailboxFilterInput.getValue() !== (this.currentPolicy().mailbox_filter ?? "")) {
					this.mailboxFilterInput.setValue(this.currentPolicy().mailbox_filter ?? "");
					return;
				}
				this.focusMode = "default-mailbox";
				this.updateFocusState();
				this.refresh();
				return;
			}
			if (this.focusMode === "default-mailbox") {
				if (this.defaultMailboxInput.getValue() !== (this.currentPolicy().default_mailbox ?? "")) {
					this.defaultMailboxInput.setValue(this.currentPolicy().default_mailbox ?? "");
					return;
				}
				this.focusMode = "profiles";
				this.updateFocusState();
				this.refresh();
				return;
			}
			this.focusMode = "profile-filter";
			this.updateFocusState();
			this.refresh();
			return;
		}
		if (matchesKey(data, "tab")) {
			if (this.focusMode === "profile-filter") this.focusMode = "profiles";
			else if (this.focusMode === "profiles") this.focusMode = "default-mailbox";
			else if (this.focusMode === "default-mailbox") this.focusMode = "mailbox-filter";
			else if (this.focusMode === "mailbox-filter") this.focusMode = "period";
			else this.focusMode = "profile-filter";
			this.updateFocusState();
			this.refresh();
			return;
		}
		if (this.focusMode === "profile-filter") {
			this.profileFilterInput.handleInput(data);
			this.applyProfileFilter();
			return;
		}
		if (this.focusMode === "default-mailbox") {
			this.defaultMailboxInput.handleInput(data);
			this.refresh();
			return;
		}
		if (this.focusMode === "mailbox-filter") {
			this.mailboxFilterInput.handleInput(data);
			this.refresh();
			return;
		}
		if (this.focusMode === "period") {
			this.periodInput.handleInput(data);
			this.refresh();
			return;
		}
		this.profilesList.handleInput(data);
	}

	render(width: number): string[] {
		const innerWidth = Math.max(30, width - 2);
		const border = (value: string) => this.theme.fg("border", value);
		const padLine = (content: string) => {
			const clipped = truncateToWidth(content, innerWidth, "", false);
			const pad = Math.max(0, innerWidth - visibleWidth(clipped));
			return `${border("│")}${clipped}${" ".repeat(pad)}${border("│")}`;
		};
		const section = (title: string) => [
			border(`├${"─".repeat(innerWidth)}┤`),
			padLine(this.theme.fg("accent", ` ${title}`)),
		];
		const lines: string[] = [border(`╭${"─".repeat(innerWidth)}╮`)];
		lines.push(...section("Proton Mail"));
		for (const line of this.titleText.render(innerWidth)) lines.push(padLine(line));
		lines.push(padLine(this.theme.fg("dim", ` Active profile: ${this.activeProfile}`)));
		lines.push(...section("Profiles"));
		for (const line of this.profileFilterInput.render(innerWidth)) lines.push(padLine(line));
		for (const line of this.profilesList.render(innerWidth)) lines.push(padLine(line));
		lines.push(...section("Default mailbox"));
		for (const line of this.defaultMailboxInput.render(innerWidth)) lines.push(padLine(line));
		lines.push(...section("Mailbox filter"));
		for (const line of this.mailboxFilterInput.render(innerWidth)) lines.push(padLine(line));
		lines.push(...section("Default period"));
		for (const line of this.periodInput.render(innerWidth)) lines.push(padLine(line));
		lines.push(...section("LLM setup"));
		for (const line of this.helpText.render(innerWidth)) lines.push(padLine(line));
		if (this.errorMessage) {
			lines.push(padLine(this.theme.fg("error", ` ${this.errorMessage}`)));
		}
		for (const line of this.footerText.render(innerWidth)) lines.push(padLine(line));
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}
}

export async function openProtonMailHub(
	ctx: Pick<ExtensionCommandContext, "cwd" | "hasUI" | "ui">,
	profiles: ProtonMailWorkingProfile[],
	rawArgs: string,
): Promise<ProtonMailHubResult | null> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Proton Mail setup hub requires interactive mode.", "warning");
		return null;
	}
	const args = parseHubArgs(rawArgs);
	return new Promise<ProtonMailHubResult | null>((resolve) => {
		void ctx.ui
			.custom(
				(tui, theme, _keybindings, done) =>
					new ProtonMailHubComponent(
						tui,
						theme,
						(value) => {
							done(value);
							resolve(value);
						},
						profiles,
						args.profile,
					),
				{ overlay: true, overlayOptions: { width: "92%", maxHeight: "92%" } },
			)
			.then(
				() => resolve(null),
				() => resolve(null),
			);
	});
}
