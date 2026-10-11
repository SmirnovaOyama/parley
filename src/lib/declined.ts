// Declined replies, as the admin review list and chat view show them.
import { atOrOn } from "./format.ts";
import { t } from "./i18n.ts";
import { useSession } from "./session.tsx";

/** A reply the AI declined: refused outright, or declined by one model and answered by another. */
export type Declined = {
  id: number;
  conversationId: string;
  title: string;
  email: string;
  /** What the person wrote, that got declined. */
  prompt: string;
  declinedBy: string;
  answeredBy: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewer: string | null;
  deletedByUser: boolean;
};

export function declinedSummary(d: Pick<Declined, "declinedBy" | "answeredBy">): string {
  return d.answeredBy ? t("{declinedBy} declined and {answeredBy} answered", { declinedBy: d.declinedBy, answeredBy: d.answeredBy }) : t("{declinedBy} gave no answer", { declinedBy: d.declinedBy });
}

/** "Reviewed by you at 14:05", naming the reviewer by email when it was another admin. */
export function useReviewedLine() {
  const { user } = useSession();
  return (d: Pick<Declined, "reviewer" | "reviewedAt">) => {
    const who = d.reviewer && d.reviewer === user?.email ? t("you") : d.reviewer ?? t("someone");
    return d.reviewedAt ? t("Reviewed by {who} {reviewedAt}", { who, reviewedAt: atOrOn(d.reviewedAt) }) : "";
  };
}
