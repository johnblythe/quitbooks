/**
 * Scores the importer + categorizer against a fake-BMO truth file.
 * Usage: npm run fake:score -- <file.csv> <file.truth.json>
 */
import { readFileSync } from "node:fs";
import type { FakeTruth } from "../src/lib/fake-bmo";
import { formatScoreReport, scoreFakeBmo } from "../src/lib/fake-bmo-score";

const [csvPath, truthPath] = process.argv.slice(2);
if (!csvPath || !truthPath) {
  console.error("Usage: npm run fake:score -- <file.csv> <file.truth.json>");
  process.exit(1);
}
const report = scoreFakeBmo(readFileSync(csvPath, "utf8"), JSON.parse(readFileSync(truthPath, "utf8")) as FakeTruth);
console.log(formatScoreReport(report));
