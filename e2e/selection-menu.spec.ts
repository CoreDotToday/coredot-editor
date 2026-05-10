import { expect, test, type Locator } from "@playwright/test";

test("selection AI toolbar does not shift or cover selected editor text", async ({ page }) => {
  const title = `Selection menu ${Date.now()}`;
  const body =
    "Revenue retention needs clearer evidence before the executive review. This sentence is long enough to verify the contextual AI toolbar placement.";

  await page.goto("/documents");
  await page.getByRole("button", { name: "New document" }).click();
  await page.getByRole("textbox", { name: "Document title" }).fill(title);

  const editor = page.getByRole("textbox", { name: "Document body" });
  await editor.fill(body);

  const beforeTop = await getTextTop(editor);
  await page.keyboard.press("ControlOrMeta+A");
  await expect(page.getByRole("toolbar", { name: "Selection AI actions" })).toBeVisible();

  const afterTop = await getTextTop(editor);
  const overlap = await page.evaluate(() => {
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Selection AI actions"]');
    const selection = window.getSelection();
    if (!toolbar || !selection || selection.rangeCount === 0) return true;

    const toolbarRect = toolbar.getBoundingClientRect();
    const selectionRect = selection.getRangeAt(0).getBoundingClientRect();
    return !(
      toolbarRect.right <= selectionRect.left ||
      toolbarRect.left >= selectionRect.right ||
      toolbarRect.bottom <= selectionRect.top ||
      toolbarRect.top >= selectionRect.bottom
    );
  });

  expect(Math.abs(afterTop - beforeTop)).toBeLessThanOrEqual(1);
  expect(overlap).toBe(false);

  await page.getByRole("button", { name: "Improve clarity" }).click();

  await expect(page.getByText(`Stub rewrite: ${body} [Command: Improve clarity]`)).toBeVisible();
  await expect(page.getByText("Fill required template fields before running selection AI.")).toHaveCount(0);
});

async function getTextTop(editor: Locator) {
  return editor.evaluate((element: Element) => {
    const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
    if (!text) return 0;

    const range = document.createRange();
    range.selectNodeContents(text);
    const { top } = range.getBoundingClientRect();
    range.detach();
    return top;
  });
}
