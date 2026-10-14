import assert from "node:assert/strict";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { test } from "node:test";
import { simpleParser } from "mailparser";
import { BRIDGE_CANCELLED_MESSAGE } from "../src/constants.ts";
import { protonBridgeListMessages } from "../src/proton-bridge.ts";
import registerProtonBridgeExtension from "../src/protonmail.ts";

const fastTimeouts = {
	connectionMs: 800,
	greetingMs: 300,
	socketMs: 5_000,
	logoutMs: 200,
};

type Fixture = {
	uid: number;
	subject: string;
	from?: string;
	messageId?: string;
	date?: string;
	structure?: string;
	headers?: string;
	source?: string;
};

function quote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function textStructure(): string {
	return '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 12 1 NIL NIL NIL NIL)';
}

function fileStructure(filename: string, disposition = "ATTACHMENT"): string {
	return `("APPLICATION" "OCTET-STREAM" ("NAME" ${quote(filename)}) NIL NIL "BASE64" 20 NIL (${quote(disposition)} ("FILENAME" ${quote(filename)})) NIL NIL)`;
}

function mixed(boundary: string, parts: string[]): string {
	return `(${parts.join("")} "MIXED" ("BOUNDARY" ${quote(boundary)}) NIL NIL NIL)`;
}

function envelope(message: Fixture): string {
	const from = message.from ?? "Ada <ada@example.com>";
	const name = from.replace(/<.*>/, "").trim() || "Ada";
	const address = from.match(/<([^>]+)>/)?.[1] ?? "ada@example.com";
	const [mailbox, host] = address.split("@");
	const addr = `((${quote(name)} NIL ${quote(mailbox ?? "ada")} ${quote(host ?? "example.com")}))`;
	return `(${quote(message.date ?? "14 Oct 2026 00:00:00 +0000")} ${quote(message.subject)} ${addr} ${addr} NIL NIL NIL NIL NIL ${quote(message.messageId ?? `<${message.uid}@example.com>`)})`;
}

function fetchLine(sequence: number, message: Fixture, command: string): string {
	const parts = [`UID ${message.uid}`, "RFC822.SIZE 120"];
	if (/ENVELOPE/i.test(command)) parts.push(`ENVELOPE ${envelope(message)}`);
	if (/BODYSTRUCTURE/i.test(command))
		parts.push(`BODYSTRUCTURE ${message.structure ?? textStructure()}`);
	let literal = "";
	if (/BODY\.PEEK\[HEADER\]/i.test(command) && message.headers) {
		const raw = Buffer.from(message.headers);
		parts.push(`BODY[HEADER] {${raw.length}}`);
		literal += `\r\n${message.headers}`;
	}
	if (/BODY\.PEEK\[\]/i.test(command) && message.source) {
		const raw = Buffer.from(message.source);
		parts.push(`BODY[] {${raw.length}}`);
		literal += `\r\n${message.source}`;
	}
	return `* ${sequence} FETCH (${parts.join(" ")}${literal})\r\n`;
}

function parseUidSet(spec: string): number[] {
	const uids: number[] = [];
	for (const part of spec.split(",")) {
		const [rawStart, rawEnd] = part.split(":");
		const start = Number(rawStart);
		const end = rawEnd === undefined ? start : Number(rawEnd);
		if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
		const step = start <= end ? 1 : -1;
		for (let uid = start; uid !== end + step; uid += step) uids.push(uid);
	}
	return uids;
}

async function startMailbox(options: {
	messages: Fixture[];
	search: (line: string) => number[];
	stallFetchAfter?: number;
}): Promise<{
	port: number;
	searches: string[];
	fetches: string[];
	stop: () => Promise<void>;
}> {
	const searches: string[] = [];
	const fetches: string[] = [];
	const sockets = new Set<Socket>();
	let fetchCount = 0;
	const byUid = new Map(options.messages.map((message) => [message.uid, message]));
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.write("* OK test ready\r\n");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let newline = buffer.indexOf("\r\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 2);
				respond(socket, line);
				newline = buffer.indexOf("\r\n");
			}
		});
	});

	function respond(socket: Socket, line: string): void {
		const tag = line.split(" ")[0] ?? "*";
		const command = (line.split(" ")[1] ?? "").toUpperCase();
		if (command === "CAPABILITY") {
			socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY\r\n`);
			return;
		}
		if (command === "LOGIN" || command === "SELECT" || command === "EXAMINE") {
			socket.write(`${tag} OK ${command}\r\n`);
			return;
		}
		if (command === "LIST") {
			socket.write(
				line.includes("*")
					? `* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK LIST\r\n`
					: `* LIST (\\Noselect) "/" ""\r\n${tag} OK LIST\r\n`,
			);
			return;
		}
		if (command === "UID" && line.toUpperCase().includes(" SEARCH")) {
			searches.push(line);
			const uids = options.search(line);
			socket.write(`* SEARCH${uids.map((uid) => ` ${uid}`).join("")}\r\n${tag} OK SEARCH\r\n`);
			return;
		}
		if (command === "UID" && line.toUpperCase().includes(" FETCH ")) {
			fetchCount += 1;
			fetches.push(line);
			if (options.stallFetchAfter !== undefined && fetchCount > options.stallFetchAfter) return;
			const spec = line.split(" ")[3] ?? "";
			let sequence = 1;
			for (const uid of parseUidSet(spec)) {
				const message = byUid.get(uid);
				if (message) socket.write(fetchLine(sequence, message, line));
				sequence += 1;
			}
			socket.write(`${tag} OK FETCH\r\n`);
			return;
		}
		if (command === "LOGOUT") {
			socket.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
			socket.end();
			return;
		}
		socket.write(`${tag} OK ${command}\r\n`);
	}

	const port = await new Promise<number>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
	});
	return {
		port,
		searches,
		fetches,
		stop: () => closeServer(server, sockets),
	};
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
	for (const socket of sockets) socket.destroy();
	return new Promise((resolve) => server.close(() => resolve()));
}

function config(port: number) {
	return {
		host: "127.0.0.1",
		imapPort: port,
		smtpPort: port,
		username: "bridge@example.com",
		password: "secret",
		security: "plain",
		defaultMailbox: "INBOX",
	};
}

function fetchedUids(fetches: string[]): number[] {
	return fetches.flatMap((line) => parseUidSet(line.split(" ")[3] ?? ""));
}

test("a fractional list limit is rejected before resolving secrets", async () => {
	// @lat: [[tests#Message previewing#Rejects a fractional limit]]
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	registerProtonBridgeExtension({
		registerMessageRenderer() {},
		registerCommand() {},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
			tools.set(tool.name, tool);
		},
	} as never);
	const previous = process.env.PROTON_BRIDGE_USERNAME;
	process.env.PROTON_BRIDGE_USERNAME = "op://vault/item/username";
	const tool = tools.get("protonmail_list_messages");
	assert.ok(tool);
	try {
		await assert.rejects(
			tool.execute("call", { limit: 0.5 }, new AbortController().signal, undefined, {
				cwd: process.cwd(),
			}),
			/positive integer/,
		);
	} finally {
		if (previous === undefined) delete process.env.PROTON_BRIDGE_USERNAME;
		else process.env.PROTON_BRIDGE_USERNAME = previous;
	}
});

test("a fractional list limit is rejected before connecting", async () => {
	await assert.rejects(
		() =>
			protonBridgeListMessages(
				config(1),
				"INBOX",
				undefined,
				undefined,
				false,
				0.5,
				false,
				undefined,
				{ timeouts: fastTimeouts },
			),
		/positive integer/,
	);
	await assert.rejects(
		() =>
			protonBridgeListMessages(
				config(1),
				"INBOX",
				undefined,
				undefined,
				false,
				1.5,
				false,
				undefined,
				{ timeouts: fastTimeouts },
			),
		/positive integer/,
	);
});

test("subject search fetches only matching message metadata", async () => {
	// @lat: [[tests#Message previewing#Searches searchable fields on the server]]
	const mailbox = await startMailbox({
		messages: [
			{ uid: 4, subject: "Other" },
			{ uid: 8, subject: "Berlin trip" },
		],
		search: (line) => (line.toUpperCase().includes("SUBJECT") ? [8] : [4, 8]),
	});
	try {
		const result = await protonBridgeListMessages(
			config(mailbox.port),
			"INBOX",
			undefined,
			"Berlin",
			false,
			20,
			false,
			["subject"],
			{ timeouts: fastTimeouts },
		);
		assert.deepEqual(
			result.messages.map((message) => message.uid),
			["8"],
		);
		assert.equal(result.messages[0]?.subject, "Berlin trip");
		assert.equal(mailbox.searches.length, 1);
		assert.match(mailbox.searches[0] ?? "", /SUBJECT/i);
		assert.doesNotMatch(mailbox.searches[0] ?? "", /\bALL\b/);
		assert.deepEqual(fetchedUids(mailbox.fetches), [8]);
		assert.equal(
			mailbox.fetches.some((line) => /BODY\.PEEK\[\]|RFC822(?!\.SIZE)/i.test(line)),
			false,
		);
	} finally {
		await mailbox.stop();
	}
});

test("field search keeps the period and unseen restrictions", async () => {
	// @lat: [[tests#Message previewing#Keeps period and unseen restrictions]]
	const mailbox = await startMailbox({
		messages: [{ uid: 3, subject: "Berlin", from: "Ada <ada@example.com>" }],
		search: () => [3],
	});
	try {
		await protonBridgeListMessages(
			config(mailbox.port),
			"INBOX",
			"2026-10",
			"Berlin",
			true,
			5,
			false,
			["subject", "from"],
			{ timeouts: fastTimeouts },
		);
		assert.equal(mailbox.searches.length, 1);
		for (const line of mailbox.searches) {
			const upper = line.toUpperCase();
			assert.equal(upper.includes("UNSEEN"), true);
			assert.equal(upper.includes("01-OCT-2026"), true);
			assert.equal(upper.includes("01-NOV-2026"), true);
		}
		const query = mailbox.searches.find((line) => line.toUpperCase().includes("SUBJECT"));
		assert.ok(query);
		const upper = query.toUpperCase();
		assert.equal(upper.includes("OR"), true);
		assert.equal(upper.includes("FROM"), true);
	} finally {
		await mailbox.stop();
	}
});

test("listing walks sparse UIDs newest first", async () => {
	// @lat: [[tests#Message previewing#Walks sparse UIDs newest first]]
	const mailbox = await startMailbox({
		messages: [
			{ uid: 2, subject: "oldest" },
			{ uid: 10, subject: "newest" },
			{ uid: 3, subject: "middle" },
		],
		search: () => [2, 10, 3],
	});
	try {
		const result = await protonBridgeListMessages(
			config(mailbox.port),
			"INBOX",
			undefined,
			undefined,
			false,
			2,
			false,
			undefined,
			{ timeouts: fastTimeouts },
		);
		assert.deepEqual(
			result.messages.map((message) => message.uid),
			["10", "3"],
		);
		assert.deepEqual(fetchedUids(mailbox.fetches), [10, 3]);
	} finally {
		await mailbox.stop();
	}
});

test("a newer attachment match wins over an older subject match", async () => {
	// @lat: [[tests#Message previewing#Prefers a newer attachment match]]
	const mailbox = await startMailbox({
		messages: [
			{ uid: 5, subject: "Berlin notes" },
			{
				uid: 9,
				subject: "Other",
				structure: mixed("outer", [textStructure(), fileStructure("Berlin.pdf")]),
			},
		],
		search: (line) => (line.toUpperCase().includes("SUBJECT") ? [5] : [5, 9]),
	});
	try {
		const result = await protonBridgeListMessages(
			config(mailbox.port),
			"INBOX",
			undefined,
			"Berlin",
			false,
			1,
			false,
			undefined,
			{ timeouts: fastTimeouts },
		);
		assert.deepEqual(
			result.messages.map((message) => message.uid),
			["9"],
		);
		assert.equal(result.messages[0]?.attachments[0]?.filename, "Berlin.pdf");
	} finally {
		await mailbox.stop();
	}
});

test("listing without a query fetches only the requested preview count", async () => {
	// @lat: [[tests#Message previewing#Fetches only the requested preview count]]
	const messages = [1, 2, 3, 4, 5].map((uid) => ({ uid, subject: `message ${uid}` }));
	const mailbox = await startMailbox({
		messages,
		search: () => messages.map((message) => message.uid),
	});
	try {
		const result = await protonBridgeListMessages(
			config(mailbox.port),
			"INBOX",
			undefined,
			undefined,
			false,
			2,
			false,
			undefined,
			{ timeouts: fastTimeouts },
		);
		assert.equal(result.count, 2);
		assert.deepEqual(fetchedUids(mailbox.fetches), [5, 4]);
	} finally {
		await mailbox.stop();
	}
});

test("an empty IMAP search does not fetch message source", async () => {
	// @lat: [[tests#Message previewing#Handles empty searches]]
	const mailbox = await startMailbox({
		messages: [{ uid: 4, subject: "Other" }],
		search: (line) => (line.toUpperCase().includes("SUBJECT") ? [] : [4]),
	});
	try {
		const result = await protonBridgeListMessages(
			config(mailbox.port),
			"INBOX",
			undefined,
			"missing",
			false,
			20,
			false,
			["subject"],
			{ timeouts: fastTimeouts },
		);
		assert.equal(result.count, 0);
		assert.deepEqual(mailbox.fetches, []);
	} finally {
		await mailbox.stop();
	}
});

test("attachments-only listing skips messages without a filename", async () => {
	// @lat: [[tests#Message previewing#Filters by attachments]]
	const mailbox = await startMailbox({
		messages: [
			{ uid: 6, subject: "plain" },
			{
				uid: 2,
				subject: "file",
				structure: mixed("files", [textStructure(), fileStructure("notes.txt")]),
			},
		],
		search: () => [6, 2],
	});
	try {
		const result = await protonBridgeListMessages(
			config(mailbox.port),
			"INBOX",
			undefined,
			undefined,
			false,
			5,
			true,
			undefined,
			{ timeouts: fastTimeouts },
		);
		assert.deepEqual(
			result.messages.map((message) => message.uid),
			["2"],
		);
	} finally {
		await mailbox.stop();
	}
});

test("attachment search reads decoded inline and nested filenames", async () => {
	// @lat: [[tests#Message previewing#Reads decoded attachment filenames]]
	const encoded = "=?UTF-8?B?QmVybGluLnBkZg==?=";
	const mailbox = await startMailbox({
		messages: [
			{
				uid: 7,
				subject: "encoded",
				structure: mixed("encoded", [textStructure(), fileStructure(encoded)]),
			},
			{
				uid: 6,
				subject: "inline",
				structure: mixed("inline", [textStructure(), fileStructure("inline-berlin.png", "INLINE")]),
			},
			{
				uid: 4,
				subject: "nested",
				structure: mixed("outer", [
					textStructure(),
					mixed("inner", [textStructure(), fileStructure("nested-berlin.txt")]),
				]),
			},
		],
		search: () => [7, 6, 4],
	});
	try {
		const result = await protonBridgeListMessages(
			config(mailbox.port),
			"INBOX",
			undefined,
			"berlin",
			false,
			10,
			false,
			["attachments"],
			{ timeouts: fastTimeouts },
		);
		assert.deepEqual(
			result.messages.map((message) => message.uid),
			["7", "6", "4"],
		);
		assert.deepEqual(
			result.messages.map((message) =>
				message.attachments.map((attachment) => attachment.filename),
			),
			[["Berlin.pdf"], ["inline-berlin.png"], ["nested-berlin.txt"]],
		);
		assert.equal(
			mailbox.fetches.some((line) => /BODY\.PEEK\[\]/i.test(line)),
			false,
		);
	} finally {
		await mailbox.stop();
	}
});

test("header search matches decoded headers and not the body", async () => {
	// @lat: [[tests#Message previewing#Searches headers without the body]]
	const mailbox = await startMailbox({
		messages: [
			{
				uid: 8,
				subject: "Hello",
				headers: "Subject: Hello\r\nX-Note: the body is not fetched\r\n\r\n",
			},
			{
				uid: 3,
				subject: "Berlin",
				headers: "Subject: =?UTF-8?Q?Berlin?=\r\n\r\n",
			},
		],
		search: () => [8, 3],
	});
	try {
		const result = await protonBridgeListMessages(
			config(mailbox.port),
			"INBOX",
			undefined,
			"Berlin",
			false,
			10,
			false,
			["headers"],
			{ timeouts: fastTimeouts },
		);
		assert.deepEqual(
			result.messages.map((message) => message.uid),
			["3"],
		);
		assert.equal(
			mailbox.fetches.some((line) => /BODY\.PEEK\[HEADER\]/i.test(line)),
			true,
		);
		assert.equal(
			mailbox.fetches.some((line) => /BODY\.PEEK\[\]/i.test(line)),
			false,
		);
	} finally {
		await mailbox.stop();
	}
});

test("body search reads the decoded message instead of IMAP BODY", async () => {
	// @lat: [[tests#Message previewing#Searches decoded message text]]
	const source = (subject: string, body: string, encoding?: string) =>
		`Subject: ${subject}\r\nFrom: Ada <ada@example.com>\r\nMessage-ID: <x@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n${encoding ? `Content-Transfer-Encoding: ${encoding}\r\n` : ""}\r\n${body}`;
	const mailbox = await startMailbox({
		messages: [
			{
				uid: 3,
				subject: "Other",
				source: source("Other", "Meet in Berl=\r\nin\r\n", "quoted-printable"),
			},
			{ uid: 2, subject: "Middle", source: source("Middle", "Meet in Berlin\r\n") },
			{ uid: 1, subject: "Berlin", source: source("Berlin", "hello\r\n") },
		],
		search: () => [3, 2, 1],
	});
	try {
		const result = await protonBridgeListMessages(
			config(mailbox.port),
			"INBOX",
			undefined,
			"Berlin",
			false,
			1,
			false,
			["body"],
			{ timeouts: fastTimeouts },
		);
		assert.deepEqual(
			result.messages.map((message) => message.uid),
			["3"],
		);
		assert.equal(
			mailbox.searches.some((line) => /\bBODY\b/i.test(line)),
			false,
		);
		assert.equal(mailbox.fetches.filter((line) => /BODY\.PEEK\[\]/i.test(line)).length, 1);
	} finally {
		await mailbox.stop();
	}
});

test("message ID and recipient searches use those IMAP keys", async () => {
	// @lat: [[tests#Message previewing#Searches message ID and recipients]]
	const mailbox = await startMailbox({
		messages: [{ uid: 4, subject: "Hello" }],
		search: () => [4],
	});
	try {
		await protonBridgeListMessages(
			config(mailbox.port),
			"INBOX",
			undefined,
			"trips@example.com",
			false,
			5,
			false,
			["messageId"],
			{ timeouts: fastTimeouts },
		);
		await protonBridgeListMessages(
			config(mailbox.port),
			"INBOX",
			undefined,
			"ada@example.com",
			false,
			5,
			false,
			["to"],
			{ timeouts: fastTimeouts },
		);
		const messageId = mailbox.searches[0]?.toUpperCase() ?? "";
		const recipient = mailbox.searches[1]?.toUpperCase() ?? "";
		assert.equal(messageId.includes("HEADER"), true);
		assert.equal(messageId.includes("MESSAGE-ID"), true);
		assert.equal(messageId.includes("TRIPS@EXAMPLE.COM"), true);
		assert.equal(recipient.includes("TO"), true);
		assert.equal(recipient.includes("ADA@EXAMPLE.COM"), true);
		assert.equal(/\bBODY\b/.test(messageId), false);
		assert.equal(/\bBODY\b/.test(recipient), false);
	} finally {
		await mailbox.stop();
	}
});

test("an invalid envelope date is omitted", async () => {
	// @lat: [[tests#Message previewing#Omits an invalid envelope date]]
	const mailbox = await startMailbox({
		messages: [{ uid: 4, subject: "Hello", date: "not-a-date" }],
		search: () => [4],
	});
	try {
		const result = await protonBridgeListMessages(
			config(mailbox.port),
			"INBOX",
			undefined,
			undefined,
			false,
			5,
			false,
			undefined,
			{ timeouts: fastTimeouts },
		);
		assert.equal(result.messages[0]?.subject, "Hello");
		assert.equal(result.messages[0]?.date, undefined);
	} finally {
		await mailbox.stop();
	}
});

test("preview attachments match parsed attachment names", async () => {
	// @lat: [[tests#Message previewing#Matches parsed attachment parts]]
	const fixtures = [
		{
			uid: 13,
			subject: "image",
			raw: `Subject: image\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=b\r\n\r\n--b\r\nContent-Type: text/html\r\n\r\n<img>\r\n--b\r\nContent-Type: image/png\r\nContent-Disposition: inline\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n--b--\r\n`,
			structure: mixed("image", [
				'("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 5 1 NIL NIL NIL NIL)',
				'("IMAGE" "PNG" NIL NIL NIL "BASE64" 8 NIL ("INLINE" NIL) NIL NIL)',
			]),
		},
		{
			uid: 12,
			subject: "pdf",
			raw: `Subject: pdf\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhello\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--b--\r\n`,
			structure: mixed("pdf", [
				textStructure(),
				'("APPLICATION" "PDF" NIL NIL NIL "BASE64" 20 NIL ("ATTACHMENT" NIL) NIL NIL)',
			]),
		},
		{
			uid: 11,
			subject: "inline text",
			raw: `Subject: inline\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\nContent-Disposition: inline\r\n\r\nhello\r\n--b\r\nContent-Type: text/html\r\nContent-Disposition: inline; filename="page.html"\r\n\r\n<p>hi</p>\r\n--b--\r\n`,
			structure: mixed("text", [
				'("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 5 1 NIL ("INLINE" NIL) NIL NIL)',
				'("TEXT" "HTML" ("CHARSET" "UTF-8" "NAME" "page.html") NIL NIL "7BIT" 5 1 NIL ("INLINE" ("FILENAME" "page.html")) NIL NIL)',
			]),
		},
		{
			uid: 10,
			subject: "notes",
			raw: `Subject: notes\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhello\r\n--b\r\nContent-Type: text/plain; name="notes.txt"\r\nContent-Disposition: attachment; filename="notes.txt"\r\n\r\nnotes\r\n--b--\r\n`,
			structure: mixed("notes", [
				textStructure(),
				'("TEXT" "PLAIN" ("CHARSET" "UTF-8" "NAME" "notes.txt") NIL NIL "7BIT" 5 1 NIL ("ATTACHMENT" ("FILENAME" "notes.txt")) NIL NIL)',
			]),
		},
		{
			uid: 9,
			subject: "eml",
			raw: `Subject: eml\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=outer\r\n\r\n--outer\r\nContent-Type: text/plain\r\n\r\nsee attached\r\n--outer\r\nContent-Type: message/rfc822; name="note.eml"\r\nContent-Disposition: attachment; filename="note.eml"\r\n\r\nSubject: inner\r\nFrom: Bob <bob@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=inner\r\n\r\n--inner\r\nContent-Type: text/plain\r\n\r\nhi\r\n--inner\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="inside.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--inner--\r\n--outer--\r\n`,
			structure: mixed("eml", [
				textStructure(),
				'("MESSAGE" "RFC822" ("NAME" "note.eml") NIL NIL "7BIT" 80 ("14 Oct 2026 00:00:00 +0000" "inner" NIL NIL NIL NIL NIL NIL NIL NIL) ("APPLICATION" "PDF" ("NAME" "inside.pdf") NIL NIL "BASE64" 20 NIL ("ATTACHMENT" ("FILENAME" "inside.pdf")) NIL NIL) 1 NIL ("ATTACHMENT" ("FILENAME" "note.eml")) NIL NIL)',
			]),
		},
	];
	const parsed = await Promise.all(
		fixtures.map(async (fixture) => {
			const message = await simpleParser(fixture.raw);
			return message.attachments.map((attachment) => ({
				filename: attachment.filename || "attachment",
				content_type: attachment.contentType,
			}));
		}),
	);
	const mailbox = await startMailbox({
		messages: fixtures,
		search: () => fixtures.map((fixture) => fixture.uid),
	});
	try {
		const result = await protonBridgeListMessages(
			config(mailbox.port),
			"INBOX",
			undefined,
			undefined,
			false,
			10,
			false,
			undefined,
			{ timeouts: fastTimeouts },
		);
		assert.deepEqual(
			result.messages.map((message) => message.uid),
			["13", "12", "11", "10", "9"],
		);
		assert.deepEqual(
			result.messages.map((message) => ({
				attachment_count: message.attachment_count,
				attachments: message.attachments.map((attachment) => ({
					filename: attachment.filename,
					content_type: attachment.content_type,
				})),
			})),
			parsed.map((attachments) => ({
				attachment_count: attachments.length,
				attachments,
			})),
		);
		assert.equal(
			result.messages.every((message) =>
				message.attachments.every((attachment) => attachment.size === undefined),
			),
			true,
		);
	} finally {
		await mailbox.stop();
	}
});

test("abort during a preview batch cancels the listing", async () => {
	// @lat: [[tests#Message previewing#Cancels during a preview batch]]
	const messages = Array.from({ length: 51 }, (_, index) => ({
		uid: index + 1,
		subject: `message ${index + 1}`,
	}));
	const mailbox = await startMailbox({
		messages,
		search: () => messages.map((message) => message.uid),
		stallFetchAfter: 1,
	});
	const controller = new AbortController();
	const pending = protonBridgeListMessages(
		config(mailbox.port),
		"INBOX",
		undefined,
		undefined,
		false,
		100,
		false,
		undefined,
		{ signal: controller.signal, timeouts: fastTimeouts },
	);
	const failure = pending.then(
		() => undefined,
		(error: unknown) => error,
	);
	try {
		const started = Date.now();
		while (mailbox.fetches.length < 2 && Date.now() - started < 2_000) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(mailbox.fetches.length >= 2, true);
		controller.abort();
		const error = await failure;
		assert.ok(error instanceof Error);
		assert.match(error.message, new RegExp(BRIDGE_CANCELLED_MESSAGE));
		assert.ok(Date.now() - started < 1_500);
	} finally {
		controller.abort();
		await failure;
		await mailbox.stop();
	}
});
