import type {
  AnalysisHistoryItem,
  ImprovementActionView,
} from "@/app/lib/weekly-cycle-types";

type CreateFormState = {
  currentAnalysisRunId: string | null;
  items: AnalysisHistoryItem[];
  plannedAction: ImprovementActionView | null;
  loading: boolean;
};

export function currentAnalysisHasAction(
  items: AnalysisHistoryItem[],
  currentAnalysisRunId: string | null
) {
  if (!currentAnalysisRunId) return false;
  return items.some(
    (item) => item.id === currentAnalysisRunId && item.action !== null
  );
}

export function shouldShowImprovementActionCreateForm({
  currentAnalysisRunId,
  items,
  plannedAction,
  loading,
}: CreateFormState) {
  return Boolean(
    currentAnalysisRunId &&
      !loading &&
      !plannedAction &&
      !currentAnalysisHasAction(items, currentAnalysisRunId)
  );
}

function isDuplicateActionBody(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    (value as { code?: unknown }).code ===
      "IMPROVEMENT_ACTION_ALREADY_EXISTS"
  );
}

export async function refreshHistoryForDuplicateAction(
  status: number,
  body: unknown,
  refreshHistory: () => Promise<void>
) {
  if (status !== 409 || !isDuplicateActionBody(body)) return false;
  await refreshHistory();
  return true;
}
