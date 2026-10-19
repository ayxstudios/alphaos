import assert from "node:assert/strict";
import { buildStageTimeline } from "../lib/orders/stage-timeline";
import { validateInternalQcPullback } from "../lib/qc/internal-qc-pullback";
import { revisionSource } from "../lib/orders/revision-source";

const base = {
  status: "awaiting_approval",
  proofId: "proof-1",
  expectedProofId: "proof-1",
  proofSentAt: "2026-10-14T05:06:43.755Z",
  proofDecision: null,
  submissionId: "asset-1",
  expectedSubmissionId: "asset-1",
  activeDesignerId: "designer-1",
};

assert.equal(validateInternalQcPullback(base), null, "an exact open proof with a current submission and designer can be pulled back");
assert.match(validateInternalQcPullback({ ...base, status: "in_design" }) ?? "", /awaiting customer/);
assert.match(validateInternalQcPullback({ ...base, proofDecision: "approved" }) ?? "", /already decided/);
assert.match(validateInternalQcPullback({ ...base, expectedSubmissionId: "asset-old" }) ?? "", /portrait changed/);
assert.match(validateInternalQcPullback({ ...base, activeDesignerId: null }) ?? "", /assigned designer/);

assert.equal(revisionSource({ via: "internal_qc_pullback" }), "internal_qc");
assert.equal(revisionSource({ via: "proof_portal" }), "customer");
assert.equal(revisionSource({ via: "va_created_revision" }), "team");

const steps = buildStageTimeline([{
  id: "event-1",
  action: "order.in_design",
  actorId: "va-1",
  actorName: "Alpha VA",
  fromState: "awaiting_approval",
  toState: "in_design",
  metadata: { via: "internal_qc_pullback", revisionReason: "The feet merge into one sandal." },
  body: null,
  createdAt: "2026-10-19T03:00:00.000Z",
}]);
assert.match(steps[0].detail ?? "", /Internal QC found a defect/);
assert.doesNotMatch(steps[0].detail ?? "", /Buyer asked/);

const legacyStaffRevision = buildStageTimeline([{
  id: "event-legacy",
  action: "order.in_design",
  actorId: "va-1",
  actorName: "Alpha VA",
  fromState: "awaiting_approval",
  toState: "in_design",
  metadata: { via: "va_created_revision", revisionReason: "Internal QC pullback." },
  body: null,
  createdAt: "2026-10-19T03:00:00.000Z",
}]);
assert.match(legacyStaffRevision[0].detail ?? "", /Team returned it/);
assert.doesNotMatch(legacyStaffRevision[0].detail ?? "", /Buyer asked/);

console.log("internal QC pullback policy and audit labels passed");
