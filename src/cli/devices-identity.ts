// `devices identity` is a thin, read-only surface over the canonical
// `gateway.identity.get` RPC: the Gateway owns the device identity file, so the
// CLI only forwards the request and formats the two fields it reports.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { callDevicesGateway, readUnlessAborted } from "./devices-cli-gateway.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "./failure-output.js";

export type DevicesIdentityOptions = {
  json?: boolean;
  timeout?: string;
  url?: string;
  token?: string;
  password?: string;
};

export type GatewayIdentityResult = {
  deviceId: string;
  publicKey: string;
};

export function renderDevicesIdentity(result: GatewayIdentityResult): string {
  return [
    theme.heading("Gateway identity"),
    `  device id:  ${sanitizeTerminalText(result.deviceId)}`,
    `  public key: ${sanitizeTerminalText(result.publicKey)}`,
  ].join("\n");
}

function reportFailure(err: unknown, opts: DevicesIdentityOptions, runtime: RuntimeEnv): void {
  rethrowExpectedCliError(err);
  const message = formatErrorMessage(err);
  if (opts.json) {
    writeRuntimeJson(runtime, { ...formatCliJsonFailure(message) });
  } else {
    runtime.error(`Gateway identity failed: ${sanitizeTerminalText(message)}`);
  }
  runtime.exit(1);
}

export async function runDevicesIdentityCommand(
  opts: DevicesIdentityOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  let result: GatewayIdentityResult | null;
  try {
    // Read-only shared state: the identity call must not create local device
    // credentials, so it goes through the same read-only Gateway helper as
    // `devices list` and `devices join-code`.
    result = await readUnlessAborted((signal) =>
      callDevicesGateway<GatewayIdentityResult>(
        "gateway.identity.get",
        {
          url: opts.url,
          token: opts.token,
          password: opts.password,
          ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
          json: opts.json,
        },
        {},
        { signal },
      ),
    );
  } catch (err) {
    reportFailure(err, opts, runtime);
    return;
  }
  if (result === null) {
    // Ctrl+C owns the exit; a read settling after it must not print.
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  runtime.log(renderDevicesIdentity(result));
}
