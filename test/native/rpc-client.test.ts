import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NativeRpcClient } from "../../src/native/rpc-client.js";

// Source and patch assertions below match multi-line text. A Windows checkout
// can materialize these files with CRLF, so normalize before comparing.
async function readCheckedOutText(...segments: string[]): Promise<string> {
  const contents = await readFile(join(process.cwd(), ...segments), "utf8");
  return contents.replace(/\r\n/g, "\n");
}

test("native RPC client correlates responses and receives notifications", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-rpc-test-"));
  const executable = join(root, "mock-native.mjs");
  const nacBinary = join(root, "IMDAppleServices");
  const stateDir = join(root, "state");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";
process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"engine.ready",params:{protocolVersion:"1"}})+"\\n");
const lines = createInterface({input:process.stdin});
lines.on("line", line => {
  const request = JSON.parse(line);
  const result = request.method === "system.version"
    ? {protocolVersion:"1",engine:"mock",testEnvironment:process.env.IBLUE_TEST_ENV,nacBinary:process.env.IBLUE_NAC_BINARY_FILE,noValidTargetRetry:process.env.IBLUE_NO_VALID_TARGET_RETRY,noLookupRetry:process.env.IBLUE_IDS_NO_LOOKUP_RETRY,dataDir:process.env.IBLUE_DATA_DIR,cwd:process.cwd()}
    : {stopped:true};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
  if (request.method === "system.shutdown") process.exit(0);
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  const client = new NativeRpcClient({
    stateDir,
    binaryPath: executable,
    nacBinaryFile: nacBinary,
    environment: {
      IBLUE_TEST_ENV: "profile-scoped",
      IBLUE_NO_VALID_TARGET_RETRY: "0",
      IBLUE_IDS_NO_LOOKUP_RETRY: "0",
    },
  });
  t.after(async () => client.close());

  const version = await client.request<{
    protocolVersion: string;
    engine: string;
    testEnvironment: string;
    nacBinary: string;
    noValidTargetRetry: string;
    noLookupRetry: string;
    dataDir: string;
    cwd: string;
  }>("system.version");
  const { cwd, ...reported } = version;
  assert.deepEqual(reported, {
    protocolVersion: "1",
    engine: "mock",
    testEnvironment: "profile-scoped",
    nacBinary,
    noValidTargetRetry: "1",
    noLookupRetry: "1",
    dataDir: stateDir,
  });
  assert.equal(await realpath(cwd), await realpath(stateDir));
  assert.equal(client.running, true);
});

test("native login diagnostics do not print Apple identity material", async () => {
  const source = await readCheckedOutText("pkg", "rustpushgo", "src", "lib.rs");
  for (const unsafeLog of [
    "hardware_headers={:?}",
    "push_token={:?}",
    "login_email_pass for {}",
  ]) {
    assert.equal(source.includes(unsafeLog), false, `unsafe native diagnostic remains: ${unsafeLog}`);
  }
});

test("native IDS alias failures neither leak Apple payloads nor require a missing alias field", async () => {
  const source = await readCheckedOutText("third_party", "rustpush-upstream", "src", "ids", "user.rs");
  assert.equal(source.includes("Got alias response"), false);
  assert.equal(source.includes("Just took action {operation} on alias"), false);
  assert.equal(source.includes("alias: Option<String>"), true);
  assert.equal(source.includes("parsed.alias.ok_or(PushError::BadMsg)?"), true);

  const patch = await readCheckedOutText("rustpush", "upstream-iblue.patch");
  const additions = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  assert.equal(additions.includes("Got alias response"), false);
  assert.equal(additions.includes("alias: Option<String>"), true);
});

test("native IDS key cache is explicitly anchored to the profile data directory", async () => {
  const source = await readCheckedOutText("pkg", "rustpushgo", "src", "lib.rs");
  assert.equal(source.includes('PathBuf::from("state/id_cache.plist")'), false);
  assert.equal(source.includes('std::fs::create_dir_all("state")'), false);
  assert.equal(
    source.includes('let ids_state_dir = PathBuf::from(subsystem_state_path("state"));'),
    true,
  );
  assert.equal(
    source.includes('let ids_cache_path = ids_state_dir.join("id_cache.plist");'),
    true,
  );
  assert.equal(source.includes('let legacy_path = "state/keystore.plist";'), false);
  assert.equal(
    source.includes('let legacy_path = format!("{}/state/keystore.plist", xdg_dir);'),
    true,
  );
});

test("native APNs socket setup uses bounded asynchronous DNS and Apple's port fallback", async () => {
  const patch = await readCheckedOutText("rustpush", "upstream-iblue.patch");
  const additions = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  assert.equal(additions.includes(".to_socket_addrs()"), false);
  assert.equal(additions.includes("const APNS_PORTS: [u16; 2] = [5223, 443];"), true);
  assert.equal(
    additions.includes("const APNS_PORT_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(20);"),
    true,
  );
  assert.equal(additions.includes("lookup_host((domain, port)).await?.collect()"), true);
  assert.equal(additions.includes("TcpStream::connect(addresses.as_slice()).await?"), true);
  assert.equal(
    additions.includes("const APNS_OPEN_SOCKET_TIMEOUT: Duration = Duration::from_secs(60);"),
    true,
  );
  assert.equal(
    additions.includes("tokio::time::timeout(\n            APNS_OPEN_SOCKET_TIMEOUT,\n            open_socket(),"),
    true,
  );
});

test("one native process owns a profile at a time and close releases the lease", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iblue-rpc-lease-test-"));
  const executable = join(root, "mock-native.mjs");
  const stateDir = join(root, "state");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";
process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"engine.ready",params:{protocolVersion:"1"}})+"\\n");
createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  const result = request.method === "system.version"
    ? {protocolVersion:"1",engine:"mock"}
    : {stopped:true};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
  if (request.method === "system.shutdown") process.exit(0);
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  const first = new NativeRpcClient({ stateDir, binaryPath: executable });
  const second = new NativeRpcClient({ stateDir, binaryPath: executable });
  t.after(async () => Promise.allSettled([first.close(), second.close()]));

  await first.request("system.version");
  await assert.rejects(
    second.request("system.version"),
    /profile native state is already in use by another iBlue process/,
  );
  await first.close();
  assert.deepEqual(await second.request("system.version"), {
    protocolVersion: "1",
    engine: "mock",
  });
});
