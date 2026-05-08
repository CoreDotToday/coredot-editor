import { expect, test } from "@playwright/test";

test("creates a document and accepts a stub AI review proposal", async ({ page }) => {
  const title = `AI workflow ${Date.now()}`;
  const body = "Revenue retention needs clearer evidence before the executive review.";

  await page.goto("/documents");

  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  await page.getByRole("button", { name: "New document" }).click();

  await expect(page).toHaveURL(/\/documents\/[^/]+$/);
  await page.getByRole("textbox", { name: "Document title" }).fill(title);
  await page.getByRole("textbox", { name: "Document body" }).fill(body);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");

  await page.getByLabel("Audience").fill("Executive leadership");
  await page.getByLabel("Document objective").fill("Improve decision readiness for the quarterly strategy review.");
  await page.getByLabel("Tone").selectOption("analytical");
  await page.getByRole("button", { name: "Review document" }).click();

  await expect(page.getByText("Stub review finding")).toBeVisible();
  await expect(page.getByText(`${body} [reviewed]`)).toBeVisible();

  const acceptProposal = page.getByRole("button", { name: `Accept proposal for ${body}` });
  await expect(acceptProposal).toBeVisible();
  await expect(page.getByRole("button", { name: `Reject proposal for ${body}` })).toBeVisible();

  await acceptProposal.click();
  await expect(page.getByText("Accepted")).toBeVisible();
});
