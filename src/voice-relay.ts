/**
 * Telnyx + ElevenLabs Voice Relay
 *
 * Can run in two modes:
 * 1) Imported by src/relay.ts (recommended): startVoiceRelay()
 * 2) Standalone CLI:
 *    - bun run src/voice-relay.ts
 *    - bun run src/voice-relay.ts call +15551234567
 *
 * Notes:
 * - Programmatic outbound calls are started with Telnyx Call Control API.
 * - Inbound "call the bot" flow is typically configured in ElevenLabs via Telnyx SIP trunk.
 */

import { timingSafeEqual } from "crypto";

const PORT = parseInt(process.env.VOICE_RELAY_PORT || "8787", 10);
const HOST = process.env.VOICE_RELAY_HOST || "0.0.0.0";
const PUBLIC_BASE_URL = (process.env.VOICE_RELAY_PUBLIC_BASE_URL || "").replace(
    /\/+$/,
    "",
);

const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";
const TELNYX_CONNECTION_ID = process.env.TELNYX_CONNECTION_ID || "";
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER || "";

const OUTBOUND_AUTH_TOKEN = process.env.VOICE_RELAY_AUTH_TOKEN || "";

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}

function text(
    body: string,
    status = 200,
    contentType = "text/plain; charset=utf-8",
): Response {
    return new Response(body, {
        status,
        headers: { "content-type": contentType },
    });
}

function requireEnv(name: string, value: string): void {
    if (!value) {
        throw new Error(`${name} is required`);
    }
}

function telnyxAuthHeader(): string {
    return `Bearer ${TELNYX_API_KEY}`;
}

function parseDynamicVariables(input: string | null): Record<string, string> {
    if (!input) return {};
    try {
        const parsed = JSON.parse(input);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        return Object.entries(parsed).reduce<Record<string, string>>(
            (acc, [k, v]) => {
                acc[k] = typeof v === "string" ? v : JSON.stringify(v);
                return acc;
            },
            {},
        );
    } catch {
        return {};
    }
}

function secureCompare(a: string, b: string): boolean {
    try {
        const aBuf = Buffer.from(a);
        const bBuf = Buffer.from(b);
        if (aBuf.length !== bBuf.length) return false;
        return timingSafeEqual(aBuf, bBuf);
    } catch {
        return false;
    }
}

export async function createTelnyxCall(
    to: string,
    dynamicVariables?: Record<string, string>,
): Promise<{ call_control_id: string; call_leg_id: string }> {
    requireEnv("TELNYX_API_KEY", TELNYX_API_KEY);
    requireEnv("TELNYX_CONNECTION_ID", TELNYX_CONNECTION_ID);
    requireEnv("TELNYX_FROM_NUMBER", TELNYX_FROM_NUMBER);

    const payload: Record<string, unknown> = {
        to,
        from: TELNYX_FROM_NUMBER,
        connection_id: TELNYX_CONNECTION_ID,
    };

    if (PUBLIC_BASE_URL) {
        payload.webhook_url = `${PUBLIC_BASE_URL}/telnyx/webhook`;
        payload.webhook_url_method = "POST";
    }

    if (dynamicVariables && Object.keys(dynamicVariables).length > 0) {
        payload.client_state = Buffer.from(
            JSON.stringify(dynamicVariables),
        ).toString("base64");
    }

    const resp = await fetch("https://api.telnyx.com/v2/calls", {
        method: "POST",
        headers: {
            authorization: telnyxAuthHeader(),
            "content-type": "application/json",
        },
        body: JSON.stringify(payload),
    });

    const bodyText = await resp.text();
    if (!resp.ok) {
        throw new Error(
            `Telnyx call create failed (${resp.status}): ${bodyText}`,
        );
    }

    let parsed:
        | {
              data?: {
                  call_control_id?: string;
                  call_leg_id?: string;
              };
          }
        | undefined;
    try {
        parsed = JSON.parse(bodyText);
    } catch {
        throw new Error(`Unexpected Telnyx response: ${bodyText}`);
    }

    const callControlId = parsed?.data?.call_control_id || "";
    const callLegId = parsed?.data?.call_leg_id || "";
    if (!callControlId || !callLegId) {
        throw new Error(`Telnyx response missing call IDs: ${bodyText}`);
    }

    return { call_control_id: callControlId, call_leg_id: callLegId };
}

function isAuthorized(request: Request): boolean {
    if (!OUTBOUND_AUTH_TOKEN) return true;
    const header = request.headers.get("authorization") || "";
    return secureCompare(header, `Bearer ${OUTBOUND_AUTH_TOKEN}`);
}

async function handleOutboundStart(request: Request): Promise<Response> {
    if (!isAuthorized(request)) {
        return text("Unauthorized", 401);
    }

    let to = "";
    let dynamicVariables: Record<string, string> = {};
    try {
        const payload = (await request.json()) as {
            to?: string;
            dynamic_variables?: Record<string, unknown>;
        };
        to = (payload.to || "").trim();
        if (
            payload.dynamic_variables &&
            typeof payload.dynamic_variables === "object"
        ) {
            dynamicVariables = Object.entries(payload.dynamic_variables).reduce<
                Record<string, string>
            >((acc, [k, v]) => {
                acc[k] = typeof v === "string" ? v : JSON.stringify(v);
                return acc;
            }, {});
        }
    } catch {
        return text("Invalid JSON body", 400);
    }

    if (!to) {
        return text("Field 'to' is required", 400);
    }

    try {
        const result = await createTelnyxCall(to, dynamicVariables);
        return json({
            ok: true,
            call_control_id: result.call_control_id,
            call_leg_id: result.call_leg_id,
            to,
        });
    } catch (error) {
        return json({ ok: false, error: String(error) }, 502);
    }
}

async function handleTelnyxWebhook(request: Request): Promise<Response> {
    let payload: unknown;
    try {
        payload = await request.json();
    } catch {
        return text("Invalid JSON", 400);
    }

    const typed = payload as {
        data?: {
            event_type?: string;
            payload?: {
                call_control_id?: string;
                call_leg_id?: string;
            };
        };
    };
    const eventType = typed?.data?.event_type || "unknown";
    const callControlId = typed?.data?.payload?.call_control_id || "";
    const callLegId = typed?.data?.payload?.call_leg_id || "";
    console.log(
        `[Telnyx webhook] ${eventType} call_control_id=${callControlId} call_leg_id=${callLegId}`,
    );
    return text("ok");
}

function printStartup(prefix = ""): void {
    const p = prefix ? `${prefix} ` : "";
    console.log(`${p}Starting Telnyx + ElevenLabs voice relay`);
    console.log(`${p}Listen: http://${HOST}:${PORT}`);
    console.log(`${p}Public base URL: ${PUBLIC_BASE_URL || "(not set)"}`);
    console.log(`${p}Telnyx API key: ${TELNYX_API_KEY ? "set" : "not set"}`);
    console.log(
        `${p}Telnyx connection id: ${TELNYX_CONNECTION_ID ? "set" : "not set"}`,
    );
    console.log(
        `${p}Outbound auth token: ${OUTBOUND_AUTH_TOKEN ? "set" : "not set"}`,
    );
}

export function shouldEnableVoiceRelay(): boolean {
    const explicit = (process.env.VOICE_RELAY_ENABLED || "").toLowerCase();
    if (explicit === "true") return true;
    if (explicit === "false") return false;
    return Boolean(
        process.env.TELNYX_API_KEY || process.env.TELNYX_CONNECTION_ID,
    );
}

export function startVoiceRelay(prefix = "[voice]"): Bun.Server<unknown> {
    printStartup(prefix);

    return Bun.serve({
        port: PORT,
        hostname: HOST,
        async fetch(request) {
            const url = new URL(request.url);

            if (request.method === "GET" && url.pathname === "/health") {
                return json({
                    ok: true,
                    service: "voice-relay",
                    time: new Date().toISOString(),
                });
            }

            if (
                request.method === "POST" &&
                url.pathname === "/telnyx/outbound/start"
            ) {
                return handleOutboundStart(request);
            }

            if (
                request.method === "POST" &&
                url.pathname === "/telnyx/webhook"
            ) {
                return handleTelnyxWebhook(request);
            }

            return text("Not found", 404);
        },
    });
}

async function cliCallMode(): Promise<void> {
    const to = (process.argv[3] || "").trim();
    if (!to) {
        console.error("Usage: bun run src/voice-relay.ts call +15551234567");
        process.exit(1);
    }

    try {
        const result = await createTelnyxCall(to);
        console.log(
            `Call started. call_control_id=${result.call_control_id} call_leg_id=${result.call_leg_id}`,
        );
    } catch (error) {
        console.error(String(error));
        process.exit(1);
    }
}

if (import.meta.main) {
    if (process.argv[2] === "call") {
        await cliCallMode();
        process.exit(0);
    }
    startVoiceRelay();
}
