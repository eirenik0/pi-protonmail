import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { Data, Effect } from "effect";

const execFile = promisify(execFileCallback);

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

function resolveSecretReferenceEffect(rawValue: string, label = "secret") {
	const reference = extractOnePasswordReference(rawValue);
	if (!reference) return Effect.succeed(rawValue);

	return Effect.tryPromise({
		try: () => execFile("op", ["read", reference]),
		catch: (error) => toSecretReferenceError(label, reference, error),
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

export async function resolveSecretReference(rawValue: string, label = "secret"): Promise<string> {
	return Effect.runPromise(resolveSecretReferenceEffect(rawValue, label));
}
