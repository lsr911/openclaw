import { beforeEach, expect, it, vi } from "vitest";
import { runDevicesIdentityCommand } from "./devices-identity.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("./gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-rpc.js")>()),
  callGatewayFromCliWithTransport: mocks.callGateway,
}));

beforeEach(() => {
  mocks.callGateway.mockReset();
});

function runtime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeStdout: vi.fn(), writeJson: vi.fn() };
}

function printed(out: ReturnType<typeof runtime>): string {
  return out.log.mock.calls.map(([line]) => String(line)).join("\n");
}

/** Runtime whose JSON writer serializes the value, so tests read the real payload. */
function jsonRuntime() {
  const chunks: string[] = [];
  return {
    out: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn((value: unknown, space?: number) => {
        chunks.push(JSON.stringify(value, undefined, space));
      }),
    },
    written: () => chunks.join(""),
  };
}

it("asks the Gateway for the identity and prints both reported fields", async () => {
  mocks.callGateway.mockResolvedValue({ deviceId: "device-1", publicKey: "public-key-1" });
  const out = runtime();

  await runDevicesIdentityCommand({}, out);

  expect(mocks.callGateway).toHaveBeenCalledTimes(1);
  expect(mocks.callGateway.mock.calls[0]?.[0]).toBe("gateway.identity.get");
  // Read-only RPC: no params are invented, because the Gateway handler reads its own state.
  expect(mocks.callGateway.mock.calls[0]?.[2]).toStrictEqual({});
  const text = printed(out);
  expect(text).toContain("Gateway identity");
  expect(text).toContain("device-1");
  expect(text).toContain("public-key-1");
  expect(out.exit).not.toHaveBeenCalled();
});

it("forwards transport options instead of reading them itself", async () => {
  mocks.callGateway.mockResolvedValue({ deviceId: "device-1", publicKey: "public-key-1" });
  const out = runtime();

  await runDevicesIdentityCommand(
    { url: "ws://127.0.0.1:1999", token: "token-1", password: "pw-1", timeout: "5000" },
    out,
  );

  expect(mocks.callGateway.mock.calls[0]?.[1]).toMatchObject({
    url: "ws://127.0.0.1:1999",
    token: "token-1",
    password: "pw-1",
    timeout: "5000",
  });
});

it("writes the raw RPC payload in JSON mode", async () => {
  mocks.callGateway.mockResolvedValue({ deviceId: "device-1", publicKey: "public-key-1" });
  const { out, written } = jsonRuntime();

  await runDevicesIdentityCommand({ json: true }, out);

  expect(JSON.parse(written())).toStrictEqual({
    deviceId: "device-1",
    publicKey: "public-key-1",
  });
  expect(out.error).not.toHaveBeenCalled();
});

it("reports a transport failure on stderr and exits 1", async () => {
  mocks.callGateway.mockRejectedValue(new Error("gateway is not reachable"));
  const out = runtime();

  await runDevicesIdentityCommand({}, out);

  expect(out.error.mock.calls[0]?.[0]).toContain(
    "Gateway identity failed: gateway is not reachable",
  );
  expect(out.exit).toHaveBeenCalledWith(1);
  // Nothing is printed to stdout when the read failed.
  expect(printed(out)).toBe("");
});

it("keeps the machine-readable failure envelope in JSON mode", async () => {
  mocks.callGateway.mockRejectedValue(new Error("gateway is not reachable"));
  const { out, written } = jsonRuntime();

  await runDevicesIdentityCommand({ json: true }, out);

  const payload = JSON.parse(written());
  expect(payload.ok).toBe(false);
  expect(payload.error.message).toBe("gateway is not reachable");
  expect(out.exit).toHaveBeenCalledWith(1);
});
