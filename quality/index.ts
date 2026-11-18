import { definePlugin } from "@oxlint/plugins";
import requireSuppressionReason from "./require-suppression-reason.ts";

import nodeTestPolicy from "./node-test-policy.ts";

export default definePlugin({
  meta: { name: "importer" },
  rules: {
    "require-suppression-reason": requireSuppressionReason,
    "node-test-policy": nodeTestPolicy,
  },
});
