import { expect, test } from "@playwright/test";
import { Document, Packer, Paragraph } from "docx";

test("imports and exports DOCX through the isolated conversion worker", async ({ page }) => {
  const sourceText = `DOCX worker flow ${Date.now()}`;
  const source = await Packer.toBuffer(new Document({
    sections: [{ children: [new Paragraph(sourceText)] }],
    title: "Worker flow",
  }));

  await page.goto("/documents");
  await page.getByLabel("DOCX 파일 선택").setInputFiles({
    buffer: source,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    name: "Worker Flow.docx",
  });

  const importReview = page.getByRole("dialog", { name: "가져오기 결과 확인" });
  await expect(importReview).toBeVisible();
  await expect(importReview.getByText("문단: 유지됨")).toBeVisible();
  await expect(page).toHaveURL(/\/documents$/);
  await importReview.getByRole("button", { name: "가져온 문서 열기" }).click();

  await expect(page).toHaveURL(/\/documents\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Worker Flow");
  await expect(page.getByRole("textbox", { name: "문서 본문" })).toContainText(sourceText);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "DOCX 내보내기" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("Worker Flow.docx");
  const stream = await download.createReadStream();
  let exportedBytes = 0;
  for await (const chunk of stream) exportedBytes += chunk.length;
  expect(exportedBytes).toBeGreaterThan(1_000);
});
