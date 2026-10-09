// Declined replies, as the admin review list and chat view show them.
import { atOrOn } from "./format.ts";
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
  return d.answeredBy ? `${d.declinedBy} declined and ${d.answeredBy} answered` : `${d.declinedBy} gave no answer`;
}

/** "Reviewed by you at 14:05", naming the reviewer by email when it was another admin. */
export function useReviewedLine() {
  const { user } = useSession();
  return (d: Pick<Declined, "reviewer" | "reviewedAt">) => {
    const who = d.reviewer && d.reviewer === user?.email ? "you" : d.reviewer ?? "someone";
    return d.reviewedAt ? `Reviewed by ${who} ${atOrOn(d.reviewedAt)}` : "";
  };
}
