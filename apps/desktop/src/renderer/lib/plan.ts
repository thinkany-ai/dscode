export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface StructuredPlan {
  explanation?: string;
  steps: Array<{ step: string; status: PlanStepStatus }>;
}

export function parseStructuredPlan(value: unknown): StructuredPlan | undefined {
  let input = value;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(input)) return undefined;

  const source = Array.isArray(input.plan) ? input.plan : Array.isArray(input.steps) ? input.steps : undefined;
  if (!source || source.length === 0) return undefined;

  const steps = source.flatMap((item) => {
    if (!isRecord(item) || typeof item.step !== "string" || !isPlanStatus(item.status)) return [];
    const step = item.step.trim();
    return step ? [{ step, status: item.status }] : [];
  });
  if (steps.length !== source.length) return undefined;

  const explanation = typeof input.explanation === "string" ? input.explanation.trim() : undefined;
  return { ...(explanation ? { explanation } : {}), steps };
}

function isPlanStatus(value: unknown): value is PlanStepStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
