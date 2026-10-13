import { execFile as execFileCallback } from "node:child_process";

import { Data, Effect } from "effect";

import { BRIDGE_CANCELLED_MESSAGE } from "./constants.ts";

function trimMatchingQuotes(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function extractOnePasswordReference(rawValue: string): string | undefined {
	const value = rawValue.trim();
	if (!value) return undefined;
	if (value.startsWith("op://")) return value;

	const wrappedCommand = value.match(/^\$\(\s*op\s+read\s+(.+?)\s*\)$/i);
	if (wrappedCommand) {
		const target = trimMatchingQuotes(wrappedCommand[1].trim());
		return target.startsWith("op://") ? target : undefined;
	}

	const plainCommand = value.match(/^op\s+read\s+(.+)$/i);
	if (plainCommand) {
		const target = trimMatchingQuotes(plainCommand[1].trim());
		return target.startsWith("op://") ? target : undefined;
	}

	return undefined;
}

export function looksLikeOnePasswordSecretReference(rawValue: string): boolean {
	return Boolean(extractOnePasswordReference(rawValue));
}

class SecretReferenceError extends Data.TaggedError("SecretReferenceError")<{
	message: string;
}> {}

function toSecretReferenceError(
	label: string,
	reference: string,
	error: unknown,
): SecretReferenceError {
	const message = error instanceof Error ? error.message : String(error);
	return new SecretReferenceError({
		message: `Failed to resolve ${label} from 1Password reference ${reference}. Make sure the 1Password CLI is installed and authenticated. ${message}`,
	});
}

function isAbortError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const name = "name" in error ? error.name : undefined;
	const code = "code" in error ? error.code : undefined;
	return name === "AbortError" || code === "ABORT_ERR";
}

function execOpRead(reference: string, signal?: AbortSignal): Promise<{ stdout: string }> {
	return new Promise((resolve, reject) => {
		execFileCallback("op", ["read", reference], { signal }, (error, stdout) => {
			if (error) reject(error);
			else resolve({ stdout });
		});
	});
}

function resolveSecretReferenceEffect(rawValue: string, label = "secret", signal?: AbortSignal) {
	const reference = extractOnePasswordReference(rawValue);
	if (!reference) return Effect.succeed(rawValue);
	if (signal?.aborted) {
		return Effect.fail(new SecretReferenceError({ message: BRIDGE_CANCELLED_MESSAGE }));
	}

	return Effect.tryPromise({
		try: () => execOpRead(reference, signal),
		catch: (error) =>
			isAbortError(error) || signal?.aborted
				? new SecretReferenceError({ message: BRIDGE_CANCELLED_MESSAGE })
				: toSecretReferenceError(label, reference, error),
	}).pipe(
		Effect.flatMap(({ stdout }) => {
			const secret = stdout.trim();
			if (!secret) {
				return Effect.fail(
					new SecretReferenceError({
						message: `1Password reference ${reference} resolved to an empty value.`,
					}),
				);
			}
			return Effect.succeed(secret);
		}),
	);
}

export async function resolveSecretReference(
	rawValue: string,
	label = "secret",
	signal?: AbortSignal,
): Promise<string> {
	return Effect.runPromise(resolveSecretReferenceEffect(rawValue, label, signal));
}
