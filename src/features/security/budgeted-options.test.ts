import { describe, expect, it, vi } from "vitest";
import { OPTIONS as reviewOptions } from "@/app/api/ai/review/route";
import { OPTIONS as rewriteOptions } from "@/app/api/ai/rewrite/route";
import { OPTIONS as documentOptions } from "@/app/api/documents/route";
import { OPTIONS as importOptions } from "@/app/api/documents/import/route";
import { OPTIONS as exportOptions } from "@/app/api/documents/[id]/export/route";
import { setRequestBudgetForTests } from "./request-budget";

describe("budgeted route OPTIONS", () => {
  it("does not consume request budget for any explicit OPTIONS handler", async () => {
    const consume = vi.fn();
    setRequestBudgetForTests({ consume });

    const responses = await Promise.all([
      reviewOptions(),
      rewriteOptions(),
      documentOptions(),
      importOptions(),
      exportOptions(),
    ]);

    expect(responses.map((response) => response.status)).toEqual([204, 204, 204, 204, 204]);
    expect(consume).not.toHaveBeenCalled();
  });
});
