import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

import type { ProtonMailProfilePolicy, ProtonMailWorkspaceConfig } from "./types.ts";

export function normalizeProtonMailProfile(profile?: string): string {
	const normalized = (profile ?? "default")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");
	return normalized || "default";
}

export function protonMailWorkspaceRoot(baseDir = ""): string {
	return join(baseDir, ".pi", "protonmail");
}

export function protonMailConfigPath(baseDir = ""): string {
	return join(protonMailWorkspaceRoot(baseDir), "config.json");
}

export function protonMailProfilesRoot(baseDir = ""): string {
	return join(protonMailWorkspaceRoot(baseDir), "profiles");
}

export function protonMailProfileDir(profile: string, baseDir = ""): string {
	return join(protonMailProfilesRoot(baseDir), normalizeProtonMailProfile(profile));
}

export function protonMailProfilePolicyPath(profile: string, baseDir = ""): string {
	return join(protonMailProfileDir(profile, baseDir), "policy.json");
}

export function normalizeProtonMailMailboxPath(pathValue: string, label: string): string {
	const trimmed = pathValue.trim();
	if (!trimmed) throw new Error(`${label} must not be empty.`);
	if (isAbsolute(trimmed)) {
		throw new Error(`${label} must be relative to the working files folder.`);
	}
	const normalized = normalize(trimmed).replaceAll("\\", "/");
	if (!normalized || normalized === ".") throw new Error(`${label} must not be empty.`);
	if (normalized.split("/").some((segment) => segment === "..")) {
		throw new Error(`${label} must not escape the working files folder.`);
	}
	return normalized;
}

async function readJsonObject<T>(path: string): Promise<T | undefined> {
	try {
		const text = await fs.readFile(path, "utf8");
		return JSON.parse(text) as T;
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return undefined;
		throw error;
	}
}

async function writeJsonObject(path: string, value: unknown): Promise<string> {
	await fs.mkdir(dirname(path), { recursive: true });
	await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	return path;
}

export async function readProtonMailWorkspaceConfig(
	cwd: string,
): Promise<ProtonMailWorkspaceConfig> {
	return (await readJsonObject<ProtonMailWorkspaceConfig>(protonMailConfigPath(cwd))) ?? {};
}

export async function writeProtonMailWorkspaceConfig(
	cwd: string,
	config: ProtonMailWorkspaceConfig,
): Promise<string> {
	return writeJsonObject(protonMailConfigPath(cwd), config);
}

export async function listProtonMailProfiles(cwd: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(protonMailProfilesRoot(cwd), { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return [];
		throw error;
	}
}

export async function readProtonMailProfilePolicy(
	cwd: string,
	profile: string,
): Promise<ProtonMailProfilePolicy> {
	return (
		(await readJsonObject<ProtonMailProfilePolicy>(protonMailProfilePolicyPath(profile, cwd))) ?? {}
	);
}

export async function writeProtonMailProfilePolicy(
	cwd: string,
	profile: string,
	policy: ProtonMailProfilePolicy,
): Promise<string> {
	return writeJsonObject(protonMailProfilePolicyPath(profile, cwd), policy);
}

export async function deleteProtonMailProfile(cwd: string, profile: string): Promise<void> {
	await fs.rm(protonMailProfileDir(profile, cwd), { recursive: true, force: true });
}
