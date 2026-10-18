import { configFromEnv } from "./config";
import { Store } from "./store";

async function hiddenPassword(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("Use --password-stdin when not attached to a terminal");
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const previousRaw = process.stdin.isRaw;
  let value = "";
  process.stderr.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const finish = (error?: Error) => {
    process.stdin.off("data", onData);
    process.stdin.setRawMode(previousRaw);
    process.stdin.pause();
    process.stderr.write("\n");
    if (error) reject(error); else resolve(value);
  };
  const onData = (data: Buffer) => {
    for (const char of data.toString("utf8")) {
      if (char === "\u0003" || char === "\u0004") { finish(new Error("Cancelled")); return; }
      if (char === "\r" || char === "\n") { finish(); return; }
      if (char === "\u007f" || char === "\b") value = [...value].slice(0, -1).join("");
      else if (char >= " " && char !== "\u001b") value += char;
      if (Buffer.byteLength(value) > 1024) { finish(new Error("Password exceeds 1024 bytes")); return; }
    }
  };
  process.stdin.on("data", onData);
  return promise;
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const usernameIndex = args.indexOf("--username");
  const username = usernameIndex >= 0 ? args[usernameIndex + 1] : undefined;
  const supported: Record<string, true> = { "--username": true, "--reset-password": true, "--password-stdin": true };
  for (let i = 0; i < args.length; i++) {
    if (!Object.hasOwn(supported, args[i]!)) throw new Error("Usage: npm run server:user -- --username NAME [--reset-password] [--password-stdin]");
    if (args[i] === "--username") i++;
  }
  if (!username) throw new Error("--username is required");
  let password = process.env.CPROJECT_ADMIN_PASSWORD;
  delete process.env.CPROJECT_ADMIN_PASSWORD;
  if (args.includes("--password-stdin")) {
    if (password !== undefined) throw new Error("Choose either CPROJECT_ADMIN_PASSWORD or --password-stdin");
    const buffers: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const data = Buffer.from(chunk as Uint8Array);
      size += data.length;
      if (size > 1026) throw new Error("Password input exceeds 1024 bytes");
      buffers.push(data);
    }
    password = Buffer.concat(buffers).toString("utf8").replace(/\r?\n$/, "");
  }
  if (password === undefined) {
    password = await hiddenPassword("Password (hidden, minimum 12 characters): ");
    if (password !== await hiddenPassword("Confirm password: ")) throw new Error("Passwords do not match");
  }
  const store = new Store(configFromEnv().dataDir);
  try {
    const user = await store.provision(username, password, args.includes("--reset-password"));
    console.log(`Account ${user.username} is ready${args.includes("--reset-password") ? "; all existing sessions revoked" : ""}.`);
  } finally { store.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Account provisioning failed"); process.exitCode = 1; });
