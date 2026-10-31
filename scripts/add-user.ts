/**
 * Creates or updates a login. Updating an existing email also signs that user out everywhere
 * (bumps users.session_version).
 *
 * Usage:
 *   npm run user:add -- <email> <name>              prompts for the password (hidden)
 *   echo 'pw' | npm run user:add -- <email> <name>   reads one line from stdin
 *   npm run user:add -- <email> <name> <password>    works, but may be saved in shell history
 */
import { sql } from "drizzle-orm";
import { scriptDb } from "./db";
import * as schema from "../src/db/schema";
import { hashPassword } from "../src/lib/password";

const MIN_LENGTH = 12;

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          return reject(new Error("Cancelled."));
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readStdinLine(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.includes("\n")) break;
  }
  return data.split(/\r?\n/)[0];
}

async function getPassword(arg: string | undefined): Promise<string> {
  if (arg !== undefined) {
    console.error(
      "Warning: a password on the command line may be saved in your shell history and is visible in `ps`. " +
        "Omit it to be prompted instead.",
    );
    return arg;
  }
  if (!process.stdin.isTTY) return readStdinLine();
  const first = await readHidden("Password: ");
  const second = await readHidden("Repeat password: ");
  if (first !== second) throw new Error("Passwords did not match.");
  return first;
}

async function main() {
  const [email, name, passwordArg] = process.argv.slice(2);
  if (!email || !name) {
    console.error("Usage: npm run user:add -- <email> <name> [password]");
    process.exit(1);
  }
  const password = await getPassword(passwordArg);
  if (password.length < MIN_LENGTH) {
    console.error(`Use a password of at least ${MIN_LENGTH} characters.`);
    process.exit(1);
  }

  const { db, close } = await scriptDb();
  const passwordHash = await hashPassword(password);
  const [row] = await db
    .insert(schema.users)
    .values({ email: email.toLowerCase(), name, passwordHash })
    .onConflictDoUpdate({
      target: schema.users.email,
      // Existing login: new password, and every session issued so far stops working.
      set: { name, passwordHash, sessionVersion: sql`${schema.users.sessionVersion} + 1` },
    })
    .returning({ sessionVersion: schema.users.sessionVersion });
  await close();
  console.log(
    `Saved login for ${name} <${email.toLowerCase()}> (session version ${row?.sessionVersion}).`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
