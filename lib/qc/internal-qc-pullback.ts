export type InternalQcPullbackState = {
  status: string;
  proofId: string | null;
  expectedProofId: string;
  proofSentAt: string | null;
  proofDecision: string | null;
  submissionId: string | null;
  expectedSubmissionId: string;
  activeDesignerId: string | null;
};

/** Validate the exact proof and artwork before staff withdraws a failed proof. */
export function validateInternalQcPullback(state: InternalQcPullbackState): string | null {
  if (state.status !== "awaiting_approval") return "Order is not awaiting customer approval.";
  if (!state.proofId || state.proofId !== state.expectedProofId || !state.proofSentAt) return "The current proof changed or was not sent.";
  if (state.proofDecision) return "This proof was already decided.";
  if (!state.submissionId || state.submissionId !== state.expectedSubmissionId) return "The portrait changed since QC.";
  if (!state.activeDesignerId) return "There is no assigned designer to return this to.";
  return null;
}
