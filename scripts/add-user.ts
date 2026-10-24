/**
 * Creates or updates a login.
 * Usage: npm run user:add -- <email> <name> <password>
 */
import { scriptDb } from "./db";
import * as schema from "../src/db/schema";
import { hashPassword } from "../src/lib/password";

async function main() {
  const [email, name, password] = process.argv.slice(2);
  if (!email || !name || !password) {
    console.error("Usage: npm run user:add -- <email> <name> <password>");
    process.exit(1);
  }
  if (password.length < 10) {
    console.error("Use a password of at least 10 characters.");
    process.exit(1);
  }

  const { db, close } = await scriptDb();
  const passwordHash = await hashPassword(password);
  await db
    .insert(schema.users)
    .values({ email: email.toLowerCase(), name, passwordHash })
    .onConflictDoUpdate({ target: schema.users.email, set: { name, passwordHash } });
  await close();
  console.log(`Saved login for ${name} <${email.toLowerCase()}>.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
