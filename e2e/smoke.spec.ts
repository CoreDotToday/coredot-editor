import { expect, test } from "@playwright/test";

test("home page boots", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("body")).toBeVisible();
});
