import { readFile } from "node:fs/promises";
import { CorpusSchema, type Corpus } from "./types.js";

export async function loadCorpus(path: string): Promise<Corpus> {
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw);
  return CorpusSchema.parse(parsed);
}
