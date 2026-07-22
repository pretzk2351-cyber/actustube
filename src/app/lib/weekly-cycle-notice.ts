import type { StatusTone } from "@/app/components/ui-foundation";

type WeeklyCycleNoticeTone = Extract<StatusTone, "error" | "success">;

export type WeeklyCycleNotice = {
  message: string;
  tone: WeeklyCycleNoticeTone;
} | null;

export function createWeeklyCycleNotice(
  tone: WeeklyCycleNoticeTone,
  message: string
): WeeklyCycleNotice {
  return { message, tone };
}
