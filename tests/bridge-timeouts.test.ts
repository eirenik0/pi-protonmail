import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import tls from "node:tls";

import {
	BRIDGE_CANCELLED_MESSAGE,
	type BridgeTimeouts,
	protonBridgeListMailboxes,
	protonBridgeSendMessage,
} from "../src/proton-bridge.ts";
import registerProtonBridgeExtension from "../src/protonmail.ts";
import { resolveSecretReference } from "../src/secret-refs.ts";
import type { ProtonBridgeConfig } from "../src/types.ts";

const fastTimeouts: Partial<BridgeTimeouts> = {
	connectionMs: 800,
	greetingMs: 300,
	socketMs: 400,
	logoutMs: 200,
};

type ImapMode = "ok" | "silent" | "stall-after-login" | "stall-list" | "stall-logout";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutCount(): number {
	return process.getActiveResourcesInfo().filter((entry) => entry === "Timeout").length;
}

function tcpCount(): number {
	return process
		.getActiveResourcesInfo()
		.filter((entry) => entry === "TCPSocketWrap" || entry === "TCPWrap").length;
}

function bridgeConfig(imapPort: number, smtpPort = imapPort): ProtonBridgeConfig {
	return {
		host: "127.0.0.1",
		imapPort,
		smtpPort,
		username: "bridge@example.com",
		password: "secret",
		security: "plain",
	};
}

function startImap(mode: ImapMode): Promise<{
	port: number;
	socketsClosed: () => boolean;
	sawStalledList: Promise<void>;
	sawLogout: Promise<void>;
	stop: () => Promise<void>;
}> {
	const sockets = new Set<Socket>();
	let noteStalledList: () => void = () => {};
	const sawStalledList = new Promise<void>((resolve) => {
		noteStalledList = resolve;
	});
	let noteLogout: () => void = () => {};
	const sawLogout = new Promise<void>((resolve) => {
		noteLogout = resolve;
	});
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		if (mode === "silent") return;
		socket.write("* OK test ready\r\n");
		let buffer = "";
		let authenticated = false;
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

		function respond(current: Socket, line: string): void {
			const tag = line.split(" ")[0] ?? "*";
			const command = (line.split(" ")[1] ?? "").toUpperCase();
			if (mode === "stall-after-login" && authenticated) return;
			if (command === "LOGOUT") noteLogout();
			if (mode === "stall-logout" && command === "LOGOUT") return;
			if (mode === "stall-list" && command === "LIST" && line.includes("*")) {
				noteStalledList();
				return;
			}
			if (command === "CAPABILITY") {
				current.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY\r\n`);
				return;
			}
			if (command === "LOGIN") {
				authenticated = true;
				current.write(`${tag} OK LOGIN\r\n`);
				return;
			}
			if (command === "LIST") {
				if (line.includes("*"))
					current.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK LIST\r\n`);
				else current.write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK LIST\r\n`);
				return;
			}
			if (command === "LOGOUT") {
				current.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
				current.end();
				return;
			}
			current.write(`${tag} OK ${command}\r\n`);
		}
	});
	return listen(server).then((port) => ({
		port,
		socketsClosed: () => sockets.size === 0,
		sawStalledList,
		sawLogout,
		stop: () => closeServer(server, sockets),
	}));
}

function startSilentSmtp(): Promise<{ port: number; stop: () => Promise<void> }> {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	return listen(server).then((port) => ({
		port,
		stop: () => closeServer(server, sockets),
	}));
}

function listen(server: Server): Promise<number> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve((server.address() as AddressInfo).port);
		});
	});
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
	for (const socket of sockets) socket.destroy();
	return new Promise((resolve) => server.close(() => resolve()));
}

function localCerts(): { key: Buffer; cert: Buffer } {
	const dir = mkdtempSync(join(tmpdir(), "proton-smtp-"));
	execFileSync("openssl", [
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-keyout",
		join(dir, "key.pem"),
		"-out",
		join(dir, "cert.pem"),
		"-days",
		"1",
		"-nodes",
		"-subj",
		"/CN=localhost",
	]);
	return {
		key: readFileSync(join(dir, "key.pem")),
		cert: readFileSync(join(dir, "cert.pem")),
	};
}

const certs = localCerts();

function sendOptions(
	port: number,
	security: string,
	extra: Partial<BridgeTimeouts> & { signal?: AbortSignal } = {},
) {
	const { signal, ...timeouts } = extra;
	return {
		config: { ...bridgeConfig(1, port), security },
		options: {
			cwd: process.cwd(),
			from: "a@example.com",
			to: ["b@example.com"],
			subject: "hello",
			body: "body",
			signal,
			timeouts: { ...fastTimeouts, ...timeouts },
		},
	};
}

function startProtocolSmtp(mode: "stall-data" | "starttls-stall-data" | "tls-silent"): Promise<{
	port: number;
	delivered: () => boolean;
	sawData: Promise<void>;
	socketsClosed: () => boolean;
	stop: () => Promise<void>;
}> {
	const sockets = new Set<Socket>();
	const delivered = false;
	let noteData: () => void = () => {};
	const sawData = new Promise<void>((resolve) => {
		noteData = resolve;
	});
	const secureContext = tls.createSecureContext(certs);
	const handle = (socket: Socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		if (mode === "tls-silent") return;
		let writer: Socket = socket;
		let buffer = "";
		let phase: "command" | "data" = "command";
		let upgraded = false;
		const write = (line: string) => writer.write(line);
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			if (phase === "data") {
				if (buffer.includes("\r\n.\r\n")) {
					noteData();
					buffer = "";
				}
				return;
			}
			let newline = buffer.indexOf("\r\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 2);
				const command = (line.split(" ")[0] ?? "").toUpperCase();
				if (command === "EHLO" || command === "HELO") {
					if (mode === "starttls-stall-data" && !upgraded)
						write("250-localhost\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n");
					else write("250-localhost\r\n250 AUTH PLAIN LOGIN\r\n");
				} else if (command === "STARTTLS") {
					write("220 ready\r\n");
					socket.removeListener("data", onData);
					const secure = new tls.TLSSocket(socket, { isServer: true, secureContext });
					writer = secure;
					upgraded = true;
					sockets.add(secure);
					secure.on("close", () => sockets.delete(secure));
					secure.on("data", onData);
				} else if (command === "DATA") {
					write("354 go\r\n");
					phase = "data";
				} else if (command === "AUTH") {
					write("235 ok\r\n");
				} else if (command === "QUIT") {
					write("221 bye\r\n");
				} else write("250 ok\r\n");
				newline = buffer.indexOf("\r\n");
			}
		};
		socket.on("data", onData);
		write("220 localhost ESMTP\r\n");
	};
	const server = mode === "tls-silent" ? tls.createServer(certs, handle) : createServer(handle);
	return listen(server).then((port) => ({
		port,
		delivered: () => delivered,
		sawData,
		socketsClosed: () => [...sockets].every((socket) => socket.destroyed),
		stop: () => closeServer(server, sockets),
	}));
}

test("stalled IMAP greeting rejects and closes the socket", async () => {
	// @lat: [[tests#Operation timeouts#Stalled greeting]]
	const imap = await startImap("silent");
	const started = Date.now();
	try {
		await assert.rejects(
			protonBridgeListMailboxes(bridgeConfig(imap.port), undefined, { timeouts: fastTimeouts }),
			/greeting/i,
		);
		assert.ok(Date.now() - started < 2000);
		await delay(50);
		assert.equal(imap.socketsClosed(), true);
	} finally {
		await imap.stop();
	}
});

test("stalled IMAP command hits the socket inactivity timeout", async () => {
	// @lat: [[tests#Operation timeouts#Stalled command]]
	const imap = await startImap("stall-after-login");
	const started = Date.now();
	try {
		await assert.rejects(
			protonBridgeListMailboxes(bridgeConfig(imap.port), undefined, { timeouts: fastTimeouts }),
			/timeout|not available|closed/i,
		);
		assert.ok(Date.now() - started < 2000);
		await delay(50);
		assert.equal(imap.socketsClosed(), true);
	} finally {
		await imap.stop();
	}
});

test("failed IMAP connect closes the client", async () => {
	// @lat: [[tests#Operation timeouts#Failed connect]]
	const server = createServer();
	const port = await listen(server);
	await closeServer(server, new Set());
	const before = tcpCount();
	const started = Date.now();
	await assert.rejects(
		protonBridgeListMailboxes(bridgeConfig(port), undefined, { timeouts: fastTimeouts }),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.equal(error.message.includes(BRIDGE_CANCELLED_MESSAGE), false);
			return true;
		},
	);
	assert.ok(Date.now() - started < 1500);
	await delay(50);
	assert.ok(tcpCount() <= before);
});

test("logout is bounded and a clean session leaves no timer behind", async () => {
	// @lat: [[tests#Operation timeouts#Bounded logout]]
	const stalled = await startImap("stall-logout");
	try {
		const started = Date.now();
		const result = await protonBridgeListMailboxes(bridgeConfig(stalled.port), undefined, {
			timeouts: fastTimeouts,
		});
		assert.ok(result.count >= 1);
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 1500, `logout waited ${elapsed}ms`);
		await delay(50);
		assert.equal(stalled.socketsClosed(), true);
	} finally {
		await stalled.stop();
	}

	const imap = await startImap("ok");
	try {
		await protonBridgeListMailboxes(bridgeConfig(imap.port), undefined, { timeouts: fastTimeouts });
		await delay(30);
		const mid = timeoutCount();
		await delay(400);
		assert.equal(timeoutCount(), mid);
		assert.equal(imap.socketsClosed(), true);
	} finally {
		await imap.stop();
	}
});

test("aborting a stalled IMAP command cancels the Bridge call", async () => {
	// @lat: [[tests#Operation timeouts#Abort cancels IMAP]]
	const imap = await startImap("stall-list");
	const controller = new AbortController();
	const started = Date.now();
	const pending = protonBridgeListMailboxes(bridgeConfig(imap.port), undefined, {
		signal: controller.signal,
		timeouts: { ...fastTimeouts, socketMs: 5_000 },
	});
	try {
		await imap.sawStalledList;
		controller.abort();
		await assert.rejects(pending, new RegExp(BRIDGE_CANCELLED_MESSAGE));
		assert.ok(Date.now() - started < 1500);
		await delay(50);
		assert.equal(imap.socketsClosed(), true);
	} finally {
		controller.abort();
		await pending.catch(() => undefined);
		await imap.stop();
	}
});

test("SMTP greeting timeout rejects the send", async () => {
	// @lat: [[tests#Operation timeouts#SMTP greeting timeout]]
	const smtp = await startSilentSmtp();
	const started = Date.now();
	try {
		await assert.rejects(
			protonBridgeSendMessage(bridgeConfig(1, smtp.port), {
				cwd: process.cwd(),
				from: "a@example.com",
				to: ["b@example.com"],
				subject: "hello",
				body: "body",
				timeouts: fastTimeouts,
			}),
			/greeting|timed out|ETIMEDOUT|timeout/i,
		);
		assert.ok(Date.now() - started < 2000);
	} finally {
		await smtp.stop();
	}
});

test("socket inactivity after login closes the mailbox listing", async () => {
	// @lat: [[tests#Operation timeouts#Post-login socket timeout]]
	const imap = await startImap("stall-list");
	const started = Date.now();
	try {
		await assert.rejects(
			protonBridgeListMailboxes(bridgeConfig(imap.port), undefined, { timeouts: fastTimeouts }),
			/timeout|not available|closed/i,
		);
		assert.ok(Date.now() - started < 2000);
		await delay(50);
		assert.equal(imap.socketsClosed(), true);
	} finally {
		await imap.stop();
	}
});

test("abort during LOGOUT closes the socket without waiting out logout", async () => {
	// @lat: [[tests#Operation timeouts#Abort during logout]]
	const imap = await startImap("stall-logout");
	const controller = new AbortController();
	const started = Date.now();
	const pending = protonBridgeListMailboxes(bridgeConfig(imap.port), undefined, {
		signal: controller.signal,
		timeouts: { ...fastTimeouts, logoutMs: 5_000, socketMs: 5_000 },
	});
	try {
		await imap.sawLogout;
		controller.abort();
		const result = await pending;
		assert.ok(result.count >= 1);
		assert.ok(Date.now() - started < 1500);
		await delay(50);
		assert.equal(imap.socketsClosed(), true);
	} finally {
		controller.abort();
		await pending.catch(() => undefined);
		await imap.stop();
	}
});

test("aborting SMTP cancels the send without waiting out the greeting", async () => {
	// @lat: [[tests#Operation timeouts#Abort cancels SMTP]]
	const smtp = await startSilentSmtp();
	const controller = new AbortController();
	const before = timeoutCount();
	const started = Date.now();
	const { config, options } = sendOptions(smtp.port, "plain", {
		signal: controller.signal,
		greetingMs: 5_000,
		socketMs: 5_000,
	});
	const pending = protonBridgeSendMessage(config, options);
	try {
		setTimeout(() => controller.abort(), 50);
		await assert.rejects(pending, new RegExp(BRIDGE_CANCELLED_MESSAGE));
		assert.ok(Date.now() - started < 1500);
		await delay(150);
		assert.equal(timeoutCount(), before);
	} finally {
		controller.abort();
		await pending.catch(() => undefined);
		await smtp.stop();
	}
});

test("abort during DATA closes SMTP before the message is accepted", async () => {
	// @lat: [[tests#Operation timeouts#Abort during SMTP data]]
	const smtp = await startProtocolSmtp("stall-data");
	const controller = new AbortController();
	const { config, options } = sendOptions(smtp.port, "plain", {
		signal: controller.signal,
		greetingMs: 5_000,
		socketMs: 5_000,
	});
	const pending = protonBridgeSendMessage(config, options);
	try {
		await smtp.sawData;
		controller.abort();
		await assert.rejects(pending, new RegExp(BRIDGE_CANCELLED_MESSAGE));
		await delay(200);
		assert.equal(smtp.delivered(), false);
		assert.equal(smtp.socketsClosed(), true);
	} finally {
		controller.abort();
		await pending.catch(() => undefined);
		await smtp.stop();
	}
});

test("abort closes an implicit TLS SMTP socket", async () => {
	// @lat: [[tests#Operation timeouts#Abort cancels implicit TLS]]
	const smtp = await startProtocolSmtp("tls-silent");
	const controller = new AbortController();
	const before = timeoutCount();
	const { config, options } = sendOptions(smtp.port, "ssl", {
		signal: controller.signal,
		greetingMs: 5_000,
		socketMs: 5_000,
	});
	const pending = protonBridgeSendMessage(config, options);
	try {
		setTimeout(() => controller.abort(), 80);
		await assert.rejects(pending, new RegExp(BRIDGE_CANCELLED_MESSAGE));
		await delay(150);
		assert.equal(smtp.socketsClosed(), true);
		assert.equal(timeoutCount(), before);
	} finally {
		controller.abort();
		await pending.catch(() => undefined);
		await smtp.stop();
	}
});

test("abort during STARTTLS send closes the socket before acceptance", async () => {
	// @lat: [[tests#Operation timeouts#Abort cancels STARTTLS]]
	const smtp = await startProtocolSmtp("starttls-stall-data");
	const controller = new AbortController();
	const { config, options } = sendOptions(smtp.port, "starttls", {
		signal: controller.signal,
		greetingMs: 5_000,
		socketMs: 5_000,
	});
	const pending = protonBridgeSendMessage(config, options);
	try {
		await smtp.sawData;
		controller.abort();
		await assert.rejects(pending, new RegExp(BRIDGE_CANCELLED_MESSAGE));
		await delay(200);
		assert.equal(smtp.delivered(), false);
		assert.equal(smtp.socketsClosed(), true);
	} finally {
		controller.abort();
		await pending.catch(() => undefined);
		await smtp.stop();
	}
});

test("a registered tool passes its abort signal through to Bridge", async () => {
	// @lat: [[tests#Operation timeouts#Tool signal reaches Bridge]]
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	registerProtonBridgeExtension({
		registerMessageRenderer() {},
		registerCommand() {},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
			tools.set(tool.name, tool);
		},
	} as never);
	const imap = await startImap("stall-list");
	const previous = {
		host: process.env.PROTON_BRIDGE_HOST,
		imap: process.env.PROTON_BRIDGE_IMAP_PORT,
		smtp: process.env.PROTON_BRIDGE_SMTP_PORT,
		security: process.env.PROTON_BRIDGE_IMAP_SECURITY,
		username: process.env.PROTON_BRIDGE_USERNAME,
		password: process.env.PROTON_BRIDGE_PASSWORD,
	};
	process.env.PROTON_BRIDGE_HOST = "127.0.0.1";
	process.env.PROTON_BRIDGE_IMAP_PORT = String(imap.port);
	process.env.PROTON_BRIDGE_SMTP_PORT = String(imap.port);
	process.env.PROTON_BRIDGE_IMAP_SECURITY = "plain";
	process.env.PROTON_BRIDGE_USERNAME = "bridge@example.com";
	process.env.PROTON_BRIDGE_PASSWORD = "secret";
	const controller = new AbortController();
	const tool = tools.get("protonmail_list_mailboxes");
	assert.ok(tool);
	const pending = tool.execute("call", {}, controller.signal, undefined, { cwd: process.cwd() });
	try {
		await imap.sawStalledList;
		controller.abort();
		await assert.rejects(pending, new RegExp(BRIDGE_CANCELLED_MESSAGE));
		await delay(50);
		assert.equal(imap.socketsClosed(), true);
	} finally {
		controller.abort();
		await pending.catch(() => undefined);
		await imap.stop();
		restoreEnv("PROTON_BRIDGE_HOST", previous.host);
		restoreEnv("PROTON_BRIDGE_IMAP_PORT", previous.imap);
		restoreEnv("PROTON_BRIDGE_SMTP_PORT", previous.smtp);
		restoreEnv("PROTON_BRIDGE_IMAP_SECURITY", previous.security);
		restoreEnv("PROTON_BRIDGE_USERNAME", previous.username);
		restoreEnv("PROTON_BRIDGE_PASSWORD", previous.password);
	}
});

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

test("an already aborted signal cancels 1Password resolution", async () => {
	// @lat: [[tests#Operation timeouts#Abort cancels secret reads]]
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		resolveSecretReference("op://vault/item/password", "Proton Bridge password", controller.signal),
		new RegExp(BRIDGE_CANCELLED_MESSAGE),
	);
});
