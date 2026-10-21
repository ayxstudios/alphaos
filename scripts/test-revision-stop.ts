import assert from "node:assert/strict";

import { evaluateRevisionStop, revisionStopMessage } from "../lib/qc/revision-stop";

function main() {
  // CPS 4197212238 (Taylor), 18 Oct: Auto QC said "no" on a5c10636 and Approve sent it anyway.
  const oct18 = {
    id: "1b8ddc04-6649-4fe7-ab3a-a3bc36a5440d",
    assetIds: ["a5c10636-2deb-4d67-930d-90a2502ac092"],
    revision: {
      done: "no",
      note: "The photobooth request remains unmet, the full-body composition has regressed.",
      missed: [
        "Include the photobooth as a recognizable part of the engagement background, rather than only its neon motif.",
        "Restore the requested full-body engagement composition.",
        "Remove the tattoos as previously requested.",
      ],
    },
  };
  const stop = evaluateRevisionStop(oct18, ["a5c10636-2deb-4d67-930d-90a2502ac092"]);
  assert.ok(stop);
  assert.equal(stop.done, "no");
  assert.equal(stop.missed.length, 3);
  assert.equal(stop.autoQcId, oct18.id);
  const msg = revisionStopMessage(stop, "4197212238");
  assert.match(msg, /^Order 4197212238: Auto QC says this revision was not done\. Missed: Include the photobooth/);
  assert.match(msg, /Fail it back to the designer/);

  // 14 Oct: "partly" (booth missing, tattoos back) stops too.
  const oct14 = { assetIds: ["613cfb63"], revision: { done: "partly", missed: ["Photo booth in the background"], note: "x" } };
  assert.equal(evaluateRevisionStop(oct14, ["613cfb63"])?.done, "partly");
  assert.match(revisionStopMessage(evaluateRevisionStop(oct14, ["613cfb63"])!, null), /^Auto QC says this revision is only partly done\. Missed: Photo booth/);

  // A finished revision, a new order (no revision verdict) and no check at all: nothing stops.
  assert.equal(evaluateRevisionStop({ assetIds: ["a"], revision: { done: "yes", missed: [] } }, ["a"]), null);
  assert.equal(evaluateRevisionStop({ assetIds: ["a"], revision: null }, ["a"]), null);
  assert.equal(evaluateRevisionStop(null, ["a"]), null);
  assert.equal(evaluateRevisionStop({ assetIds: ["a"], revision: { done: "maybe" } }, ["a"]), null);

  // The designer uploaded again after the check: the newer file waits for its own check.
  assert.equal(evaluateRevisionStop(oct18, ["newer-upload"]), null);
  // Two portraits, only one re-uploaded: the check no longer matches what goes out, the screen shows it as older.
  assert.equal(evaluateRevisionStop({ assetIds: ["p1", "p2"], revision: { done: "no" } }, ["p1", "p2-new"]), null);
  // Same two files in another order: still a stop.
  assert.ok(evaluateRevisionStop({ assetIds: ["p2", "p1"], revision: { done: "no" } }, ["p1", "p2", "p1"]));

  // No missed list: the note stands in; neither: the plain line.
  assert.match(revisionStopMessage({ done: "no", missed: [], note: "Faces unchanged.", autoQcId: null }, "PC1"), /not done\. Faces unchanged\. Fail/);
  assert.match(revisionStopMessage({ done: "partly", missed: [], note: null, autoQcId: null }, null), /partly done\. Fail/);
  // At most four missed items in the message.
  const many = evaluateRevisionStop({ assetIds: ["a"], revision: { done: "no", missed: ["1", "2", "3", "4", "5", " ", 7] } }, ["a"])!;
  assert.deepEqual(many.missed, ["1", "2", "3", "4", "5"]);
  assert.match(revisionStopMessage(many, null), /Missed: 1; 2; 3; 4\. /);

  console.log("test:revision-stop OK");
}

main();
