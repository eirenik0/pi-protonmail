#!/usr/bin/env python3
import json
import os
import re
import shutil
import socket
import ssl
import sys
from dataclasses import dataclass
from datetime import date, datetime
from email import policy
from email.parser import BytesParser
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
import imaplib


@dataclass
class BridgeConfig:
    host: str
    imap_port: int
    smtp_port: int
    username: str
    password: str
    security: str
    default_mailbox: str | None = None


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    return json.loads(raw) if raw.strip() else {}


def json_dump(value: Any) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False))


def fail(message: str, *, code: int = 1) -> None:
    json_dump({"ok": False, "error": message})
    raise SystemExit(code)


def sanitize_filename(value: str) -> str:
    text = re.sub(r"[\\/:*?\"<>|\r\n]+", "_", value).strip()
    text = re.sub(r"\s+", " ", text)
    return text or "unnamed"


def sanitize_path_segment(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._")
    return text or "item"


def probe_port(host: str, port: int, timeout: float = 1.5) -> dict[str, Any]:
    sock = socket.socket()
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        banner = b""
        try:
            banner = sock.recv(256)
        except Exception:
            banner = b""
        return {
            "open": True,
            "banner": banner.decode("utf-8", "replace").strip(),
        }
    except Exception as error:
        return {"open": False, "error": str(error)}
    finally:
        sock.close()


def create_ssl_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


def connect_imap(config: BridgeConfig) -> imaplib.IMAP4:
    security = (config.security or "starttls").strip().lower()
    if security == "ssl":
        client = imaplib.IMAP4_SSL(config.host, config.imap_port, ssl_context=create_ssl_context())
    else:
        client = imaplib.IMAP4(config.host, config.imap_port)
        if security in ("starttls", "auto"):
            capabilities = {
                (cap.decode("utf-8", "replace") if isinstance(cap, (bytes, bytearray)) else str(cap)).upper()
                for cap in getattr(client, "capabilities", [])
            }
            if "STARTTLS" in capabilities:
                client.starttls(create_ssl_context())
                client.capability()
            elif security == "starttls":
                raise RuntimeError("Proton Bridge IMAP endpoint does not advertise STARTTLS.")
    client.login(config.username, config.password)
    return client


_LIST_RE = re.compile(r'^\((?P<flags>[^)]*)\) (?P<delimiter>NIL|"[^"]*") (?P<name>.+)$')


def parse_list_mailbox(line: bytes | str) -> dict[str, Any]:
    text = line.decode("utf-8", "replace") if isinstance(line, (bytes, bytearray)) else str(line)
    match = _LIST_RE.match(text)
    if not match:
        return {"raw": text, "name": text, "flags": [], "delimiter": None}

    raw_name = match.group("name")
    if raw_name.startswith('"') and raw_name.endswith('"'):
        raw_name = raw_name[1:-1].replace('\\"', '"')

    delimiter = match.group("delimiter")
    if delimiter == "NIL":
        parsed_delimiter = None
    else:
        parsed_delimiter = delimiter[1:-1]

    flags = [flag for flag in match.group("flags").split() if flag]
    return {
        "raw": text,
        "name": raw_name,
        "flags": flags,
        "delimiter": parsed_delimiter,
    }


def parse_mailboxes(lines: list[bytes], query: str | None = None) -> list[dict[str, Any]]:
    rows = [parse_list_mailbox(line) for line in lines]
    if query:
        needle = query.casefold()
        rows = [row for row in rows if needle in row["name"].casefold() or needle in row["raw"].casefold()]
    rows.sort(key=lambda row: row["name"].casefold())
    return rows


def month_range(period: str) -> tuple[str, str]:
    if not re.fullmatch(r"\d{4}-\d{2}", period):
        raise ValueError(f"Invalid period '{period}'. Expected YYYY-MM.")
    year = int(period[:4])
    month = int(period[5:7])
    start = date(year, month, 1)
    if month == 12:
        end = date(year + 1, 1, 1)
    else:
        end = date(year, month + 1, 1)
    return start.strftime("%d-%b-%Y"), end.strftime("%d-%b-%Y")


def search_uids(client: imaplib.IMAP4, mailbox: str, period: str | None = None, unseen_only: bool = False) -> list[str]:
    status, _ = client.select(f'"{mailbox}"', readonly=True)
    if status != "OK":
        raise RuntimeError(f"Could not select mailbox '{mailbox}'.")

    criteria: list[str] = ["UNSEEN"] if unseen_only else ["ALL"]
    if period:
        start, end = month_range(period)
        criteria.extend(["SINCE", start, "BEFORE", end])

    status, data = client.uid("search", None, *criteria)
    if status != "OK":
        raise RuntimeError(f"IMAP search failed in mailbox '{mailbox}'.")

    first = data[0] if data and data[0] else ""
    raw = (first.decode("utf-8", "replace") if isinstance(first, (bytes, bytearray)) else str(first)).strip()
    return [uid for uid in raw.split() if uid]


def message_summary(uid: str, raw_message: bytes) -> dict[str, Any]:
    message = BytesParser(policy=policy.default).parsebytes(raw_message)
    attachments: list[dict[str, Any]] = []
    for index, part in enumerate(message.iter_attachments(), start=1):
        filename = part.get_filename() or f"attachment-{index}"
        payload = part.get_payload(decode=True) or b""
        attachments.append({
            "filename": filename,
            "content_type": part.get_content_type(),
            "size": len(payload),
        })

    received = message.get("date")
    received_iso = None
    if received:
        try:
            received_iso = parsedate_to_datetime(received).isoformat()
        except Exception:
            received_iso = received

    from_value = message.get("from", "")
    subject = message.get("subject", "")
    return {
        "uid": uid,
        "message_id": message.get("message-id", "").strip(),
        "from": from_value,
        "subject": subject,
        "date": received_iso,
        "attachments": attachments,
        "attachment_count": len(attachments),
        "raw_size": len(raw_message),
    }


def matches_query(summary: dict[str, Any], query: str | None) -> bool:
    if not query:
        return True
    needle = query.casefold()
    haystacks = [summary.get("subject", ""), summary.get("from", ""), summary.get("message_id", "")]
    haystacks.extend(attachment.get("filename", "") for attachment in summary.get("attachments", []))
    return any(needle in str(value).casefold() for value in haystacks if value)


def fetch_messages(config: BridgeConfig, mailbox: str, period: str | None = None, unseen_only: bool = False, query: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    client = connect_imap(config)
    try:
        uids = search_uids(client, mailbox, period, unseen_only)
        selected = list(reversed(uids))[: max(limit, 1) * 5]
        messages: list[dict[str, Any]] = []
        for uid in selected:
            status, data = client.uid("fetch", uid, "(BODY.PEEK[])")
            if status != "OK" or not data:
                continue
            payload = next((item[1] for item in data if isinstance(item, tuple) and len(item) > 1), None)
            if not payload:
                continue
            summary = message_summary(uid, payload)
            if not matches_query(summary, query):
                continue
            messages.append(summary)
            if len(messages) >= limit:
                break
        return messages
    finally:
        try:
            client.logout()
        except Exception:
            pass


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def save_import(config: BridgeConfig, *, cwd: str, entity: str, period: str, mailbox: str, unseen_only: bool = False, query: str | None = None, mark_seen: bool = False, limit: int = 100) -> dict[str, Any]:
    if not re.fullmatch(r"\d{4}-\d{2}", period):
        raise ValueError(f"Invalid period '{period}'. Expected YYYY-MM.")

    year = period[:4]
    spendings_root = Path(cwd) / entity / year / "Spendings"
    mail_root = spendings_root / "_mail" / sanitize_path_segment(mailbox)
    inbox_root = spendings_root / "_inbox"
    spendings_root.mkdir(parents=True, exist_ok=True)
    mail_root.mkdir(parents=True, exist_ok=True)
    inbox_root.mkdir(parents=True, exist_ok=True)

    client = connect_imap(config)
    imported_messages: list[dict[str, Any]] = []
    imported_attachment_count = 0
    try:
        status, _ = client.select(f'"{mailbox}"', readonly=not mark_seen)
        if status != "OK":
            raise RuntimeError(f"Could not select mailbox '{mailbox}'.")

        uids = search_uids(client, mailbox, period, unseen_only)
        selected = list(reversed(uids))[: max(limit, 1) * 10]

        for uid in selected:
            fetch_mode = "(BODY.PEEK[])" if not mark_seen else "(BODY[])"
            status, data = client.uid("fetch", uid, fetch_mode)
            if status != "OK" or not data:
                continue
            payload = next((item[1] for item in data if isinstance(item, tuple) and len(item) > 1), None)
            if not payload:
                continue

            summary = message_summary(uid, payload)
            if summary["attachment_count"] == 0:
                continue
            if not matches_query(summary, query):
                continue

            message_dir = mail_root / f"uid-{uid}"
            message_dir.mkdir(parents=True, exist_ok=True)
            raw_path = message_dir / "raw.eml"
            raw_path.write_bytes(payload)

            message = BytesParser(policy=policy.default).parsebytes(payload)
            saved_attachments: list[dict[str, Any]] = []
            for index, part in enumerate(message.iter_attachments(), start=1):
                filename = sanitize_filename(part.get_filename() or f"attachment-{index}")
                file_bytes = part.get_payload(decode=True) or b""
                saved_name = f"{index:02d}__{filename}"
                attachment_path = message_dir / saved_name
                attachment_path.write_bytes(file_bytes)

                inbox_name = f"uid-{uid}__{saved_name}"
                inbox_path = inbox_root / inbox_name
                if not inbox_path.exists():
                    shutil.copyfile(attachment_path, inbox_path)

                saved_attachments.append({
                    "filename": filename,
                    "content_type": part.get_content_type(),
                    "size": len(file_bytes),
                    "mail_path": str(attachment_path.relative_to(Path(cwd))),
                    "inbox_path": str(inbox_path.relative_to(Path(cwd))),
                })
                imported_attachment_count += 1

            meta = {
                "entity": entity,
                "period": period,
                "mailbox": mailbox,
                "uid": uid,
                "message_id": summary.get("message_id"),
                "from": summary.get("from"),
                "subject": summary.get("subject"),
                "date": summary.get("date"),
                "attachment_count": len(saved_attachments),
                "attachments": saved_attachments,
                "raw_path": str(raw_path.relative_to(Path(cwd))),
                "saved_at": datetime.utcnow().isoformat() + "Z",
            }
            (message_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            imported_messages.append(meta)

            if mark_seen:
                client.uid("store", uid, "+FLAGS", r"(\\Seen)")
            if len(imported_messages) >= limit:
                break

        return {
            "spendings_root": str(spendings_root.relative_to(Path(cwd))),
            "mail_root": str(mail_root.relative_to(Path(cwd))),
            "inbox_root": str(inbox_root.relative_to(Path(cwd))),
            "message_count": len(imported_messages),
            "attachment_count": imported_attachment_count,
            "messages": imported_messages,
        }
    finally:
        try:
            client.logout()
        except Exception:
            pass


def build_config(payload: dict[str, Any]) -> BridgeConfig:
    config = payload.get("config") or {}
    return BridgeConfig(
        host=config.get("host") or "127.0.0.1",
        imap_port=int(config.get("imap_port") or 1143),
        smtp_port=int(config.get("smtp_port") or 1025),
        username=config.get("username") or "",
        password=config.get("password") or "",
        security=config.get("security") or "starttls",
        default_mailbox=config.get("default_mailbox") or None,
    )


def status_op(payload: dict[str, Any]) -> dict[str, Any]:
    config = build_config(payload)
    imap_probe = probe_port(config.host, config.imap_port)
    smtp_probe = probe_port(config.host, config.smtp_port)
    result = {
        "config": {
            "host": config.host,
            "imap_port": config.imap_port,
            "smtp_port": config.smtp_port,
            "security": config.security,
            "default_mailbox": config.default_mailbox,
            "username_set": bool(config.username),
            "password_set": bool(config.password),
        },
        "imap": imap_probe,
        "smtp": smtp_probe,
    }

    if config.username and config.password and imap_probe.get("open"):
        try:
            client = connect_imap(config)
            status, rows = client.list()
            mailboxes = parse_mailboxes(rows or []) if status == "OK" else []
            result["login"] = {"ok": True, "mailbox_count": len(mailboxes), "mailboxes": mailboxes[:10]}
            client.logout()
        except Exception as error:
            result["login"] = {"ok": False, "error": str(error)}
    return result


def list_mailboxes_op(payload: dict[str, Any]) -> dict[str, Any]:
    config = build_config(payload)
    if not config.username or not config.password:
        raise RuntimeError("Missing Proton Bridge username/password.")
    query = payload.get("query")
    client = connect_imap(config)
    try:
        status, rows = client.list()
        if status != "OK":
            raise RuntimeError("IMAP LIST failed.")
        mailboxes = parse_mailboxes(rows or [], query)
        return {"mailboxes": mailboxes, "count": len(mailboxes)}
    finally:
        try:
            client.logout()
        except Exception:
            pass


def list_messages_op(payload: dict[str, Any]) -> dict[str, Any]:
    config = build_config(payload)
    if not config.username or not config.password:
        raise RuntimeError("Missing Proton Bridge username/password.")
    mailbox = payload.get("mailbox") or config.default_mailbox
    if not mailbox:
        raise RuntimeError("No mailbox provided and PROTON_BRIDGE_DEFAULT_MAILBOX is not set.")
    messages = fetch_messages(
        config,
        mailbox=mailbox,
        period=payload.get("period"),
        unseen_only=bool(payload.get("unseen_only")),
        query=payload.get("query"),
        limit=int(payload.get("limit") or 20),
    )
    return {"mailbox": mailbox, "count": len(messages), "messages": messages}


def import_attachments_op(payload: dict[str, Any]) -> dict[str, Any]:
    config = build_config(payload)
    if not config.username or not config.password:
        raise RuntimeError("Missing Proton Bridge username/password.")
    mailbox = payload.get("mailbox") or config.default_mailbox
    if not mailbox:
        raise RuntimeError("No mailbox provided and PROTON_BRIDGE_DEFAULT_MAILBOX is not set.")
    entity = payload.get("entity")
    period = payload.get("period")
    cwd = payload.get("cwd") or os.getcwd()
    if entity not in {"Fluxomnia", "Zivnost"}:
        raise RuntimeError("Entity must be Fluxomnia or Zivnost.")
    if not period:
        raise RuntimeError("Missing period.")
    result = save_import(
        config,
        cwd=cwd,
        entity=entity,
        period=period,
        mailbox=mailbox,
        unseen_only=bool(payload.get("unseen_only")),
        query=payload.get("query"),
        mark_seen=bool(payload.get("mark_seen")),
        limit=int(payload.get("limit") or 100),
    )
    result["mailbox"] = mailbox
    return result


OPERATIONS = {
    "status": status_op,
    "list-mailboxes": list_mailboxes_op,
    "list-messages": list_messages_op,
    "import-attachments": import_attachments_op,
}


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in OPERATIONS:
        fail("Usage: proton_bridge.py <status|list-mailboxes|list-messages|import-attachments>")
    payload = read_payload()
    try:
        result = OPERATIONS[sys.argv[1]](payload)
        json_dump({"ok": True, "result": result})
    except Exception as error:
        fail(str(error))


if __name__ == "__main__":
    main()
