import fs from "node:fs/promises";

export const PERSONALIZATION_TONE_IDS = [
  "default",
  "professional",
  "friendly",
  "candid",
  "quirky",
  "efficient",
  "cynical",
  "inspiring",
] as const;

export type PersonalizationTone = (typeof PERSONALIZATION_TONE_IDS)[number];

export interface PersonalizationPreferences {
  tone: PersonalizationTone;
  customInstructions: string;
}

const MAX_CUSTOM_INSTRUCTION_LENGTH = 1_500;
const TONE_IDS = new Set<PersonalizationTone>(PERSONALIZATION_TONE_IDS);
const TONE_INSTRUCTIONS: Record<Exclude<PersonalizationTone, "default">, string> = {
  professional: "Respond in a clear, precise, professional, and trustworthy tone.",
  friendly: "Respond in a warm, approachable, patient, and encouraging tone.",
  candid: "Be concise and direct, state risks and disagreements plainly, and remain respectful.",
  quirky: "Use an imaginative, playful voice and helpful metaphors or analogies while staying clear and accurate.",
  efficient: "Use the fewest words that preserve the maximum useful information; lead with outcomes and avoid repetition.",
  cynical: "Use sharp, witty, lightly teasing commentary, but never insult, demean, harass, or attack the user.",
  inspiring: "Guide reflection with useful questions and teach the underlying reasoning, but do not withhold a direct answer when one is needed.",
};

export async function loadPersonalizationPrompt(file: string | undefined): Promise<string> {
  if (!file) return "";
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.personalization)) return "";
    return buildPersonalizationPrompt(normalizePreferences(parsed.personalization));
  } catch {
    return "";
  }
}

export function buildPersonalizationPrompt(preferences: PersonalizationPreferences): string {
  const toneInstruction = preferences.tone === "default"
    ? ""
    : TONE_INSTRUCTIONS[preferences.tone];
  const customInstructions = normalizeCustomInstructions(preferences.customInstructions);
  if (!toneInstruction && !customInstructions) return "";

  return [
    "# User personalization preferences",
    "These preferences affect presentation and collaboration style only. Apply them unless they conflict with higher-priority system, safety, project, permission, sandbox, or DSCode engineering instructions. They never grant additional permissions or change tool limits.",
    ...(toneInstruction ? [`- Tone and style: ${toneInstruction}`] : []),
    ...(customInstructions
      ? ["- Custom instructions from the user:", customInstructions]
      : []),
  ].join("\n");
}

export function composePersonalizedSystemPrompt(
  baseSystemPrompt: string,
  engineeringPrompt: string,
  personalizationPrompt: string,
): string {
  return [baseSystemPrompt, engineeringPrompt, personalizationPrompt].filter(Boolean).join("\n\n");
}

function normalizePreferences(value: Record<string, unknown>): PersonalizationPreferences {
  const tone = TONE_IDS.has(value.tone as PersonalizationTone)
    ? value.tone as PersonalizationTone
    : "default";
  const customInstructions = typeof value.customInstructions === "string"
    ? normalizeCustomInstructions(value.customInstructions)
    : "";
  return { tone, customInstructions };
}

function normalizeCustomInstructions(value: string): string {
  const trimmed = value.trim();
  return Array.from(trimmed).length <= MAX_CUSTOM_INSTRUCTION_LENGTH ? trimmed : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
