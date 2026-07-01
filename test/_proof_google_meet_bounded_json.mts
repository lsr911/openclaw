/**
 * Real behavior proof: Google Meet bounded JSON response reads.
 *
 * All three Google Meet extension data functions (calendar, meet, oauth)
 * were switched from unbounded `response.json()` to shared `readResponseWithLimit`
 * with provider-specific caps (1 MiB OAuth, 4 MiB calendar/meet).
 *
 * This proof starts real node:http servers that stream oversized JSON without
 * Content-Length, then drives `readResponseWithLimit` against them with both
 * caps.  A negative control confirms unbounded `response.text()` buffers past
 * the 4 MiB cap.
 *
 * Usage: node --import tsx test/_proof_google_meet_bounded_json.mts
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Real readResponseWithLimit (same import path as Google Meet production code)
// ---------------------------------------------------------------------------
const { readResponseWithLimit } = await import(
  "openclaw/plugin-sdk/response-limit-runtime"
);

const MEET_CAP = 4 * 1024 * 1024;   // GOOGLE_MEET_JSON_RESPONSE_MAX_BYTES / GOOGLE_CALENDAR_JSON_RESPONSE_MAX_BYTES
const OAUTH_CAP = 1 * 1024 * 1024;  // GOOGLE_MEET_OAUTH_JSON_RESPONSE_MAX_BYTES

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`PASS  ${label}${detail ? ` :: ${detail}` : ""}`); }
  else { fail++; console.error(`FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
}

function startServer(
  bytes: number,
): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      let sent = 0;
      const chunk = Buffer.alloc(65536, 0x78);
      function writeChunk() {
        if (sent >= bytes) { res.end("\n]}"); return; }
        const header = sent === 0 ? '{"data":["' : "";
        const payload = header ? Buffer.concat([Buffer.from(header), chunk]) : chunk;
        sent += payload.length;
        if (!res.write(payload)) res.once("drain", writeChunk);
        else setImmediate(writeChunk);
      }
      writeChunk();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ port: addr.port, server });
    });
  });
}

function jsonServer(body: unknown): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      res.end(payload);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ port: addr.port, server });
    });
  });
}

// ---------------------------------------------------------------------------
// Proof
// ---------------------------------------------------------------------------
async function main() {
  const OVERSIZED = 6 * 1024 * 1024; // > MEET_CAP (4 MiB), < OAUTH_CAP check size

  // ---- Proof A: Meet/Calendar cap (4 MiB) rejects 6 MiB body ----------
  {
    const { port, server } = await startServer(OVERSIZED);
    console.log(`[proof] oversized (${OVERSIZED} bytes) server on :${port}, cap=${MEET_CAP}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      let thrown = false;
      let msg = "";
      try {
        await readResponseWithLimit(res, MEET_CAP, {
          onOverflow: ({ maxBytes }) =>
            new Error(`Google Meet JSON response exceeds ${maxBytes} bytes`),
        });
      } catch (err: unknown) {
        thrown = true; msg = String(err);
      }
      check(
        "meet/calendar cap (4 MiB): oversized body throws bounded error",
        thrown && msg.includes(String(MEET_CAP)),
        `threw=${thrown} msg="${msg.slice(0, 80)}"`,
      );
    } finally {
      server.close();
    }
  }

  // ---- Proof B: OAuth cap (1 MiB) rejects 6 MiB body ------------------
  {
    const { port, server } = await startServer(OVERSIZED);
    console.log(`[proof] oversized (${OVERSIZED} bytes) server on :${port}, cap=${OAUTH_CAP}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      let thrown = false;
      let msg = "";
      try {
        await readResponseWithLimit(res, OAUTH_CAP, {
          onOverflow: ({ maxBytes }) =>
            new Error(`Google Meet OAuth JSON response exceeds ${maxBytes} bytes`),
        });
      } catch (err: unknown) {
        thrown = true; msg = String(err);
      }
      check(
        "oauth cap (1 MiB): oversized body throws bounded error",
        thrown && msg.includes(String(OAUTH_CAP)),
        `threw=${thrown} msg="${msg.slice(0, 80)}"`,
      );
    } finally {
      server.close();
    }
  }

  // ---- Proof C: Small body parses correctly with both caps ------------
  {
    const { port, server } = await jsonServer({ status: "ok", items: [{ id: "evt-1" }] });
    console.log(`[proof] small JSON server on :${port}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const body = await readResponseWithLimit(res, MEET_CAP, {
        onOverflow: ({ maxBytes }) =>
          new Error(`Google Meet JSON response exceeds ${maxBytes} bytes`),
      });
      const json = JSON.parse(body.toString("utf8"));
      check(
        "small JSON body: parsed correctly with meet cap",
        json.status === "ok" && Array.isArray(json.items) && json.items.length === 1,
        `status=${json.status} items=${json.items?.length}`,
      );
    } finally {
      server.close();
    }
  }

  // ---- Proof D: Negative control — unbounded read buffers past cap ----
  {
    const { port, server } = await startServer(OVERSIZED);
    console.log(`[proof] negative control server on :${port}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const text = await res.text();
      check(
        "negative control: unbounded read buffers past 4 MiB cap",
        text.length > MEET_CAP,
        `buffered=${text.length} (> ${MEET_CAP})`,
      );
    } finally {
      server.close();
    }
  }

  console.log(`\n[proof] ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[proof] harness failed:", err);
  process.exit(1);
});
