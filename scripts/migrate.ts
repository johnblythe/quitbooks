import { scriptDb } from "./db";

async function main() {
  const { migrate, close } = await scriptDb();
  await migrate();
  await close();
  console.log("Migrations applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
