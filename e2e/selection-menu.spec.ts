import { expect, test, type Locator, type Page } from "@playwright/test";

test("selection AI toolbar does not shift or cover selected editor text", async ({ page }) => {
  const title = `Selection menu ${Date.now()}`;
  const body =
    "Revenue retention needs clearer evidence before the executive review. This sentence is long enough to verify the contextual AI toolbar placement.";

  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();
  await page.getByRole("textbox", { name: "문서 제목" }).fill(title);

  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await editor.fill(body);

  const beforeTop = await getTextTop(editor);
  await page.keyboard.press("ControlOrMeta+A");
  await expect(page.getByRole("toolbar", { name: "선택 AI 작업" })).toBeVisible();

  const afterTop = await getTextTop(editor);
  const overlap = await page.evaluate(() => {
    const toolbar = document.querySelector('[role="toolbar"][aria-label="선택 AI 작업"]');
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

  await expect(page.getByRole("button", { name: "한국어로 번역" })).toBeVisible();
  await expect(page.getByRole("button", { name: "영어로 번역" })).toBeVisible();
  await page.route("**/api/ai/rewrite", async (route) => {
    await page.waitForTimeout(750);
    await route.continue();
  });
  await page.getByRole("button", { name: "한국어로 번역" }).click();

  const commandStatus = page.getByRole("status", { name: "AI 명령 진행 상태" });
  await expect(commandStatus).toContainText("한국어로 번역 실행 중...");
  await editor.click({ position: { x: 12, y: 12 } });
  await expect(commandStatus).toContainText("원본 선택 영역 기준으로 계속 처리합니다.");

  const editorWorkspace = page.getByRole("region", { name: "에디터 작업 영역" });
  const selectionResult = editorWorkspace.getByRole("region", { name: "선택 AI 결과" });
  await expect(selectionResult).toBeVisible();
  await expect(commandStatus).toHaveCount(0);
  await expect(selectionResult).toContainText("한국어로 번역");
  await expect(selectionResult).toContainText("원문");
  await expect(selectionResult).toContainText(body);
  await expect(selectionResult).toContainText("제안");
  await expect(selectionResult).toContainText(`Stub rewrite: ${body}`);
  await expect(selectionResult.getByRole("button", { name: "아래에 추가" })).toBeVisible();
  await expect(page.getByRole("status", { name: "문서 저장 상태" })).toHaveText("저장됨");
  await selectionResult.getByRole("button", { name: "아래에 추가" }).click();

  await expect(page.getByRole("status", { name: "선택 AI 적용 상태" })).toContainText("초안에 반영되었습니다");
  await expect(page.getByRole("status", { name: "문서 저장 상태" })).toHaveText(/저장되지 않음|저장 중|저장됨/);
  await expect(editor).toContainText(body);
  await expect(editor).toContainText(`Stub rewrite: ${body}`);
  await expect(page.getByText("선택 AI 실행 전에 필수 템플릿 필드를 입력하세요.")).toHaveCount(0);
});

test("text selection hides block gutter controls so floating menus do not overlap", async ({ page }) => {
  const title = `Selection gutter collision ${Date.now()}`;
  const firstItem = "첫 번째 항목은 선택 전 블록 컨트롤을 보여 줍니다.";
  const secondItem = "두 번째 항목을 선택하면 AI 메뉴만 떠야 합니다.";

  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();
  await page.getByRole("textbox", { name: "문서 제목" }).fill(title);

  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await editor.click();
  await page.keyboard.type("- ");
  await page.keyboard.type(firstItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondItem);

  const secondItemBox = await page.getByText(secondItem).boundingBox();
  expect(secondItemBox).not.toBeNull();
  await page.mouse.move(secondItemBox!.x + 8, secondItemBox!.y + secondItemBox!.height / 2);
  await expect(page.getByRole("toolbar", { name: "블록 컨트롤" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+A");
  await expect(page.getByRole("toolbar", { name: "선택 AI 작업" })).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "블록 컨트롤" })).toHaveCount(0);
  await page.mouse.move(secondItemBox!.x + 16, secondItemBox!.y + secondItemBox!.height / 2);
  await expect(page.getByRole("toolbar", { name: "블록 컨트롤" })).toHaveCount(0);

  const selectedTextIsCovered = await page.evaluate(() => {
    const toolbar = document.querySelector('[role="toolbar"][aria-label="선택 AI 작업"]');
    const selection = window.getSelection();
    if (!toolbar || !selection || selection.rangeCount === 0) return true;

    const toolbarRect = toolbar.getBoundingClientRect();
    return Array.from(selection.getRangeAt(0).getClientRects()).some(
      (selectionRect) =>
        !(
          toolbarRect.right <= selectionRect.left ||
          toolbarRect.left >= selectionRect.right ||
          toolbarRect.bottom <= selectionRect.top ||
          toolbarRect.top >= selectionRect.bottom
        ),
    );
  });
  expect(selectedTextIsCovered).toBe(false);
});

test("Mod+A selects the current block first and the whole editor on the second press", async ({ page }) => {
  const title = `Block selection ${Date.now()}`;
  const firstBlock = "First block should stay out of the first shortcut selection.";
  const secondBlock = "Second block should be selected first.";

  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();
  await page.getByRole("textbox", { name: "문서 제목" }).fill(title);

  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await editor.click();
  await page.keyboard.type(firstBlock);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondBlock);
  await expect.poll(() => readBrowserSelection(page)).toBe("");

  await page.keyboard.press("ControlOrMeta+A");
  await expect.poll(() => readBrowserSelection(page)).toBe(secondBlock);

  await page.keyboard.press("ControlOrMeta+A");
  await expect.poll(() => readBrowserSelection(page)).toContain(firstBlock);
  await expect.poll(() => readBrowserSelection(page)).toContain(secondBlock);
});

test("block gutter appears for the current block without a text selection", async ({ page }) => {
  const title = `Block gutter ${Date.now()}`;
  const body = "Current block should expose gutter controls without selecting text.";

  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();
  await page.getByRole("textbox", { name: "문서 제목" }).fill(title);

  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await editor.click();
  await page.keyboard.type(body);

  await expect.poll(() => readBrowserSelection(page)).toBe("");
  await expect(page.getByRole("toolbar", { name: "블록 컨트롤" })).toBeVisible();

  await page.getByRole("button", { name: "아래에 블록 추가" }).click();
  await expect.poll(() => readEditorParagraphs(editor)).toEqual([body]);
  await expect(page.locator(".tiptap p")).toHaveCount(2);
});

test("block gutter plus inserts below the hovered block", async ({ page }) => {
  const title = `Block add ${Date.now()}`;
  const firstBlock = "First block should receive the inserted block below it.";
  const secondBlock = "Second block keeps the cursor before hover.";
  const insertedBlock = "Inserted below the hovered first block.";

  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();
  await page.getByRole("textbox", { name: "문서 제목" }).fill(title);

  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await editor.click();
  await page.keyboard.type(firstBlock);
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondBlock);

  const firstBlockBox = await page.getByText(firstBlock).boundingBox();
  expect(firstBlockBox).not.toBeNull();
  await page.mouse.move(firstBlockBox!.x + 8, firstBlockBox!.y + firstBlockBox!.height / 2);
  await page.getByRole("button", { name: "아래에 블록 추가" }).click();
  await page.keyboard.type(insertedBlock);

  await expect.poll(() => readEditorParagraphs(editor)).toEqual([firstBlock, insertedBlock, secondBlock]);
});

test("block gutter stays outside markdown list text", async ({ page }) => {
  const title = `List gutter ${Date.now()}`;
  const body = "안녕하세요 반갑습니다";

  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();
  await page.getByRole("textbox", { name: "문서 제목" }).fill(title);

  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await editor.click();
  await page.keyboard.type("- ");
  await page.keyboard.type(body);

  const gutter = page.getByRole("toolbar", { name: "블록 컨트롤" });
  await expect(gutter).toBeVisible();
  await expect(editor.locator("li")).toContainText(body);

  const overlapsListText = await page.evaluate(() => {
    const toolbar = document.querySelector('[role="toolbar"][aria-label="블록 컨트롤"]');
    const listItem = document.querySelector(".tiptap li");
    if (!toolbar || !listItem) return true;

    const textNode = document.createTreeWalker(listItem, NodeFilter.SHOW_TEXT).nextNode();
    if (!textNode) return true;

    const range = document.createRange();
    range.selectNodeContents(textNode);
    const toolbarRect = toolbar.getBoundingClientRect();
    const textRect = range.getBoundingClientRect();
    range.detach();

    return toolbarRect.right > textRect.left - 6 && toolbarRect.left < textRect.right;
  });

  expect(overlapsListText).toBe(false);

  const listTextGap = await page.evaluate(() => {
    const toolbar = document.querySelector('[role="toolbar"][aria-label="블록 컨트롤"]');
    const listItem = document.querySelector(".tiptap li");
    if (!toolbar || !listItem) return 0;

    const textNode = document.createTreeWalker(listItem, NodeFilter.SHOW_TEXT).nextNode();
    if (!textNode) return 0;

    const range = document.createRange();
    range.selectNodeContents(textNode);
    const toolbarRect = toolbar.getBoundingClientRect();
    const textRect = range.getBoundingClientRect();
    range.detach();

    return textRect.left - toolbarRect.right;
  });

  expect(listTextGap).toBeGreaterThanOrEqual(16);
});

test("block gutter plus inserts below the hovered list item", async ({ page }) => {
  const title = `List add ${Date.now()}`;
  const firstItem = "첫 번째 리스트 항목";
  const secondItem = "두 번째 리스트 항목";
  const insertedItem = "첫 번째 아래에 추가된 항목";

  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();
  await page.getByRole("textbox", { name: "문서 제목" }).fill(title);

  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await editor.click();
  await page.keyboard.type("- ");
  await page.keyboard.type(firstItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondItem);

  const firstItemBox = await page.getByText(firstItem).boundingBox();
  expect(firstItemBox).not.toBeNull();
  await page.mouse.move(firstItemBox!.x + 8, firstItemBox!.y + firstItemBox!.height / 2);
  await page.getByRole("button", { name: "아래에 블록 추가" }).click();
  await page.keyboard.type(insertedItem);

  await expect.poll(() => readEditorListItems(editor)).toEqual([firstItem, insertedItem, secondItem]);
  await expect.poll(() => readNonEmptyTopLevelEditorTags(editor)).toEqual(["UL"]);
});

test("block gutter follows the hovered list row when the pointer is in list indentation", async ({ page }) => {
  const title = `List indentation gutter ${Date.now()}`;
  const firstItem = "이미지 생성이 필요하다면";
  const secondItem = "ㅁ";
  const thirdItem = "ㅠ";
  const fourthItem = "이";

  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();
  await page.getByRole("textbox", { name: "문서 제목" }).fill(title);

  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await editor.click();
  await page.keyboard.type("- ");
  await page.keyboard.type(firstItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(thirdItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(fourthItem);

  const firstItemBox = await editor.locator("li p").nth(0).boundingBox();
  const fourthItemBox = await editor.locator("li p").nth(3).boundingBox();
  expect(firstItemBox).not.toBeNull();
  expect(fourthItemBox).not.toBeNull();

  await page.mouse.move(fourthItemBox!.x - 24, fourthItemBox!.y + fourthItemBox!.height / 2);
  const gutterBox = await page.getByRole("toolbar", { name: "블록 컨트롤" }).boundingBox();
  expect(gutterBox).not.toBeNull();

  expect(Math.abs(gutterBox!.y - fourthItemBox!.y)).toBeLessThan(18);
  expect(Math.abs(gutterBox!.y - firstItemBox!.y)).toBeGreaterThan(24);
});

test("block gutter appears for nested list items and inserts below that nested item", async ({ page }) => {
  const title = `Nested list gutter ${Date.now()}`;
  const parentItem = "pnpm test → 37 files, 212 tests passed";
  const nestedItem = "pnpm e2e → 18 passed";
  const nestedSibling = "pnpm build";
  const insertedNestedItem = "nested inserted command";

  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();
  await page.getByRole("textbox", { name: "문서 제목" }).fill(title);

  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await editor.click();
  await page.keyboard.type("- ");
  await page.keyboard.type(parentItem);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type(nestedItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(nestedSibling);

  const parentItemBox = await editor.getByText(parentItem, { exact: true }).boundingBox();
  const nestedItemBox = await editor.getByText(nestedItem, { exact: true }).boundingBox();
  expect(parentItemBox).not.toBeNull();
  expect(nestedItemBox).not.toBeNull();

  await page.mouse.move(nestedItemBox!.x - 24, nestedItemBox!.y + nestedItemBox!.height / 2);
  const gutterBox = await page.getByRole("toolbar", { name: "블록 컨트롤" }).boundingBox();
  expect(gutterBox).not.toBeNull();
  expect(Math.abs(gutterBox!.y - nestedItemBox!.y)).toBeLessThan(18);
  expect(Math.abs(gutterBox!.y - parentItemBox!.y)).toBeGreaterThan(24);

  await page.getByRole("button", { name: "아래에 블록 추가" }).click();
  await page.keyboard.type(insertedNestedItem);

  await expect.poll(() => readEditorDirectListItems(editor)).toEqual([parentItem]);
  await expect.poll(() => readEditorNestedListItems(editor)).toEqual([
    nestedItem,
    insertedNestedItem,
    nestedSibling,
  ]);
});

test("slash menu applies block commands from the editor", async ({ page }) => {
  const title = `Slash menu ${Date.now()}`;

  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();
  await page.getByRole("textbox", { name: "문서 제목" }).fill(title);

  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await editor.click();
  await page.keyboard.type("/");

  const slashMenu = page.getByRole("listbox", { name: "슬래시 명령" });
  await expect(slashMenu).toBeVisible();
  await slashMenu.getByRole("option", { name: /제목 1/ }).click();

  await expect(editor.locator("h1")).toBeVisible();
  await expect(editor.locator("h1")).toHaveText("");
});

test("block handle drags the hovered block above another block", async ({ page }) => {
  const title = `Block drag ${Date.now()}`;
  const firstBlock = "First draggable block.";
  const secondBlock = "Second target block.";

  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();
  await page.getByRole("textbox", { name: "문서 제목" }).fill(title);

  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await editor.click();
  await page.keyboard.type(firstBlock);
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondBlock);

  const secondBlockBox = await page.getByText(secondBlock).boundingBox();
  expect(secondBlockBox).not.toBeNull();
  await page.mouse.move(secondBlockBox!.x + 8, secondBlockBox!.y + secondBlockBox!.height / 2);

  const dragHandle = page.getByRole("button", { name: "블록 메뉴 열기" });
  const dragHandleBox = await dragHandle.boundingBox();
  const editorBox = await editor.boundingBox();
  const firstBlockBox = await page.getByText(firstBlock).boundingBox();
  expect(dragHandleBox).not.toBeNull();
  expect(editorBox).not.toBeNull();
  expect(firstBlockBox).not.toBeNull();

  await page.mouse.move(dragHandleBox!.x + dragHandleBox!.width / 2, dragHandleBox!.y + dragHandleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstBlockBox!.x + 24, firstBlockBox!.y + 2, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => readEditorParagraphs(editor)).toEqual([secondBlock, firstBlock]);
});

test("block menu moves hovered blocks without dragging", async ({ page }) => {
  const firstBlock = "First menu movable block.";
  const secondBlock = "Second menu movable block.";
  const editor = await createNewDocument(page, `Block menu move ${Date.now()}`);

  await page.keyboard.type(firstBlock);
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondBlock);

  const firstBlockBox = await editor.getByText(firstBlock, { exact: true }).boundingBox();
  expect(firstBlockBox).not.toBeNull();
  await page.mouse.move(firstBlockBox!.x + 8, firstBlockBox!.y + firstBlockBox!.height / 2);
  const gutterBox = await page.getByRole("toolbar", { name: "블록 컨트롤" }).boundingBox();
  expect(gutterBox).not.toBeNull();
  expect(Math.abs(gutterBox!.y - firstBlockBox!.y)).toBeLessThan(18);
  await page.getByRole("button", { name: "블록 메뉴 열기" }).click();
  await page.getByRole("menuitem", { name: "블록 아래로 이동" }).click();

  await expect.poll(() => readEditorParagraphs(editor)).toEqual([secondBlock, firstBlock]);
});

test("block menu indents and outdents list items", async ({ page }) => {
  const firstItem = "Root list item";
  const secondItem = "Child candidate item";
  const editor = await createNewDocument(page, `List level menu ${Date.now()}`);

  await page.keyboard.type("- ");
  await page.keyboard.type(firstItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondItem);

  await openBlockMenuForText(page, editor, secondItem);
  await page.getByRole("menuitem", { name: "들여쓰기" }).click();

  await expect.poll(() => readEditorDirectListItems(editor)).toEqual([firstItem]);
  await expect.poll(() => readEditorNestedListItems(editor)).toEqual([secondItem]);

  await openBlockMenuForText(page, editor, secondItem);
  await page.getByRole("menuitem", { name: "내어쓰기" }).click();

  await expect.poll(() => readEditorDirectListItems(editor)).toEqual([firstItem, secondItem]);
  await expect.poll(() => readEditorNestedListItems(editor)).toEqual([]);
});

test("block menu turns a list item into a normal text block", async ({ page }) => {
  const firstItem = "First item stays in the list";
  const secondItem = "Second item becomes text";
  const thirdItem = "Third item stays in the next list";
  const editor = await createNewDocument(page, `List item to text ${Date.now()}`);

  await page.keyboard.type("- ");
  await page.keyboard.type(firstItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(thirdItem);

  await openBlockMenuForText(page, editor, secondItem);
  await page.getByRole("menuitem", { name: "텍스트로 전환" }).click();

  await expect.poll(() => readNonEmptyTopLevelEditorTags(editor)).toEqual(["UL", "P", "UL"]);
  await expect.poll(() => readTopLevelParagraphs(editor)).toEqual([secondItem]);
  await expect.poll(() => readTopLevelListItemsByList(editor)).toEqual([[firstItem], [thirdItem]]);
});

test("block handle shows a drop indicator while dragging", async ({ page }) => {
  const title = `Block drag indicator ${Date.now()}`;
  const firstBlock = "First block for indicator.";
  const secondBlock = "Second block for indicator.";

  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();
  await page.getByRole("textbox", { name: "문서 제목" }).fill(title);

  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await editor.click();
  await page.keyboard.type(firstBlock);
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondBlock);

  const secondBlockBox = await page.getByText(secondBlock).boundingBox();
  expect(secondBlockBox).not.toBeNull();
  await page.mouse.move(secondBlockBox!.x + 8, secondBlockBox!.y + secondBlockBox!.height / 2);

  const dragHandle = page.getByRole("button", { name: "블록 메뉴 열기" });
  const dragHandleBox = await dragHandle.boundingBox();
  const firstBlockBox = await page.getByText(firstBlock).boundingBox();
  expect(dragHandleBox).not.toBeNull();
  expect(firstBlockBox).not.toBeNull();

  await page.mouse.move(dragHandleBox!.x + dragHandleBox!.width / 2, dragHandleBox!.y + dragHandleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstBlockBox!.x + 24, firstBlockBox!.y + 2, { steps: 8 });

  await expect(page.locator("[data-block-drop-indicator='true']")).toBeVisible();
  await page.mouse.up();

  await expect.poll(() => readEditorParagraphs(editor)).toEqual([secondBlock, firstBlock]);
  await expect(page.locator("[data-block-drop-indicator='true']")).toHaveCount(0);
});

test("block handle shows a drop indicator when dragged along the gutter rail", async ({ page }) => {
  const title = `Block rail drag ${Date.now()}`;
  const firstBlock = "First block for rail dragging.";
  const secondBlock = "Second block for rail dragging.";

  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();
  await page.getByRole("textbox", { name: "문서 제목" }).fill(title);

  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await editor.click();
  await page.keyboard.type(firstBlock);
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondBlock);

  const secondBlockBox = await page.getByText(secondBlock).boundingBox();
  expect(secondBlockBox).not.toBeNull();
  await page.mouse.move(secondBlockBox!.x + 8, secondBlockBox!.y + secondBlockBox!.height / 2);

  const dragHandle = page.getByRole("button", { name: "블록 메뉴 열기" });
  const dragHandleBox = await dragHandle.boundingBox();
  const firstBlockBox = await page.getByText(firstBlock).boundingBox();
  expect(dragHandleBox).not.toBeNull();
  expect(firstBlockBox).not.toBeNull();

  const gutterX = dragHandleBox!.x + dragHandleBox!.width / 2;
  await page.mouse.move(gutterX, dragHandleBox!.y + dragHandleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(gutterX, firstBlockBox!.y + 2, { steps: 8 });

  await expect(page.locator("[data-block-drop-indicator='true']")).toBeVisible();
  await page.mouse.up();

  await expect.poll(() => readEditorParagraphs(editor)).toEqual([secondBlock, firstBlock]);
});

test("block handle reorders markdown list items with a visible drop indicator", async ({ page }) => {
  const scenarios = [
    {
      marker: "- ",
      tag: "UL",
      title: "bullet",
    },
    {
      marker: "1. ",
      tag: "OL",
      title: "ordered",
    },
    {
      slashOption: /작업 목록/,
      slashQuery: "todo",
      tag: "UL",
      title: "task",
    },
  ] as const;

  for (const scenario of scenarios) {
    const firstItem = `${scenario.title} first item`;
    const secondItem = `${scenario.title} second item`;
    const thirdItem = `${scenario.title} third item`;
    const editor = await createNewDocument(page, `List drag ${scenario.title} ${Date.now()}`);

    if ("marker" in scenario) {
      await page.keyboard.type(scenario.marker);
    } else {
      await runSlashCommand(page, scenario.slashQuery, scenario.slashOption);
    }

    await page.keyboard.type(firstItem);
    await page.keyboard.press("Enter");
    await page.keyboard.type(secondItem);
    await page.keyboard.press("Enter");
    await page.keyboard.type(thirdItem);

    await dragBlockTextAboveText(page, editor, thirdItem, firstItem);

    await expect.poll(() => readEditorListItems(editor)).toEqual([thirdItem, firstItem, secondItem]);
    await expect.poll(() => readTopLevelEditorTags(editor)).toContain(scenario.tag);
    await expect(page.locator("[data-block-drop-indicator='true']")).toHaveCount(0);
  }
});

test("block handle moves a numbered list item into another list", async ({ page }) => {
  const orderedFirst = "First numbered source";
  const orderedSecond = "Second numbered source";
  const bulletFirst = "First bullet target";
  const bulletSecond = "Second bullet target";
  const editor = await createNewDocument(page, `Numbered cross-list drag ${Date.now()}`);

  await page.keyboard.type("1. ");
  await page.keyboard.type(orderedFirst);
  await page.keyboard.press("Enter");
  await page.keyboard.type(orderedSecond);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- ");
  await page.keyboard.type(bulletFirst);
  await page.keyboard.press("Enter");
  await page.keyboard.type(bulletSecond);

  await dragBlockTextAboveText(page, editor, orderedSecond, bulletSecond);

  await expect.poll(() => readTopLevelEditorTags(editor)).toContain("OL");
  await expect.poll(() => readTopLevelEditorTags(editor)).toContain("UL");
  await expect.poll(() => readEditorListItems(editor)).toEqual([orderedFirst, bulletFirst, orderedSecond, bulletSecond]);
  await expect.poll(() => readSelectedListItemText(page)).toBe(orderedSecond);
  await expect(page.locator("[data-block-drop-indicator='true']")).toHaveCount(0);
});

test("block handle reorders nested list siblings with a visible drop indicator", async ({ page }) => {
  const parentItem = "Parent command";
  const firstNestedItem = "pnpm e2e";
  const secondNestedItem = "pnpm build";
  const thirdNestedItem = "git diff check";
  const editor = await createNewDocument(page, `Nested list drag ${Date.now()}`);

  await page.keyboard.type("- ");
  await page.keyboard.type(parentItem);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type(firstNestedItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondNestedItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(thirdNestedItem);

  await dragBlockTextAboveText(page, editor, thirdNestedItem, firstNestedItem);

  await expect.poll(() => readEditorNestedListItems(editor)).toEqual([
    thirdNestedItem,
    firstNestedItem,
    secondNestedItem,
  ]);
  await expect.poll(() => readEditorDirectListItems(editor)).toEqual([parentItem]);
  await expect(page.locator("[data-block-drop-indicator='true']")).toHaveCount(0);
});

test("block handle keeps the caret on the moved list item", async ({ page }) => {
  const firstItem = "First list item";
  const secondItem = "Second list item";
  const thirdItem = "Third list item";
  const editor = await createNewDocument(page, `List drag focus ${Date.now()}`);

  await page.keyboard.type("- ");
  await page.keyboard.type(firstItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(thirdItem);

  await dragBlockTextAboveText(page, editor, thirdItem, firstItem);

  await expect.poll(() => readEditorListItems(editor)).toEqual([thirdItem, firstItem, secondItem]);
  await expect.poll(() => readSelectedListItemText(page)).toBe(thirdItem);
});

test("block handle converts a dragged paragraph into a list item", async ({ page }) => {
  const paragraph = "Loose string block";
  const firstItem = "First list target";
  const secondItem = "Second list target";
  const editor = await createNewDocument(page, `Paragraph into list ${Date.now()}`);

  await page.keyboard.type(paragraph);
  await page.keyboard.press("Enter");
  await page.keyboard.type("- ");
  await page.keyboard.type(firstItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondItem);

  await dragBlockTextAboveText(page, editor, paragraph, secondItem);

  await expect.poll(() => readNonEmptyTopLevelEditorTags(editor)).toEqual(["UL"]);
  await expect.poll(() => readEditorDirectListItems(editor)).toEqual([firstItem, paragraph, secondItem]);
  await expect.poll(() => readSelectedListItemText(page)).toBe(paragraph);
});

test("double Enter exits a bullet list into a normal paragraph", async ({ page }) => {
  const item = "Only list item";
  const paragraph = "Normal paragraph after list";
  const editor = await createNewDocument(page, `List exit ${Date.now()}`);

  await page.keyboard.type("- ");
  await page.keyboard.type(item);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type(paragraph);

  await expect.poll(() => readNonEmptyTopLevelEditorTags(editor)).toEqual(["UL", "P"]);
  await expect.poll(() => readEditorDirectListItems(editor)).toEqual([item]);
  await expect.poll(() => readTopLevelParagraphs(editor)).toEqual([paragraph]);
});

test("double Enter exits a numbered list into a normal paragraph", async ({ page }) => {
  const item = "Only numbered item";
  const paragraph = "Normal paragraph after numbered list";
  const editor = await createNewDocument(page, `Numbered list exit ${Date.now()}`);

  await page.keyboard.type("1. ");
  await page.keyboard.type(item);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type(paragraph);

  await expect.poll(() => readNonEmptyTopLevelEditorTags(editor)).toEqual(["OL", "P"]);
  await expect.poll(() => readEditorDirectListItems(editor)).toEqual([item]);
  await expect.poll(() => readTopLevelParagraphs(editor)).toEqual([paragraph]);
});

test("block handle can keep a dragged paragraph between list items", async ({ page }) => {
  const paragraph = "Loose paragraph between list items";
  const firstItem = "First split target";
  const secondItem = "Second split target";
  const editor = await createNewDocument(page, `Paragraph between list items ${Date.now()}`);

  await page.keyboard.type(paragraph);
  await page.keyboard.press("Enter");
  await page.keyboard.type("- ");
  await page.keyboard.type(firstItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondItem);

  await dragBlockTextAboveTextInTopLevelRail(page, editor, paragraph, secondItem);

  await expect.poll(() => readNonEmptyTopLevelEditorTags(editor)).toEqual(["UL", "P", "UL"]);
  await expect.poll(() => readTopLevelParagraphs(editor)).toEqual([paragraph]);
  await expect.poll(() => readTopLevelListItemsByList(editor)).toEqual([[firstItem], [secondItem]]);
});

test("block handle converts a dragged paragraph into a numbered list item", async ({ page }) => {
  const paragraph = "Loose numbered string block";
  const firstItem = "First numbered target";
  const secondItem = "Second numbered target";
  const editor = await createNewDocument(page, `Paragraph into ordered list ${Date.now()}`);

  await page.keyboard.type(paragraph);
  await page.keyboard.press("Enter");
  await page.keyboard.type("1. ");
  await page.keyboard.type(firstItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondItem);

  await dragBlockTextAboveText(page, editor, paragraph, secondItem);

  await expect.poll(() => readTopLevelEditorTags(editor)).toEqual(["OL", "P"]);
  await expect.poll(() => readEditorDirectListItems(editor)).toEqual([firstItem, paragraph, secondItem]);
  await expect.poll(() => readSelectedListItemText(page)).toBe(paragraph);
});

test("block handle moves a deeply nested list item into an ancestor list position", async ({ page }) => {
  const firstRootItem = "반갑습니다";
  const secondRootItem = "하하하";
  const firstNestedItem = "1";
  const secondNestedItem = "2";
  const movedNestedItem = "3";
  const movedChildItem = "4";
  const editor = await createNewDocument(page, `Deep list drag ${Date.now()}`);

  await page.keyboard.type("안녕하세요");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- ");
  await page.keyboard.type(firstRootItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondRootItem);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type(firstNestedItem);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type(secondNestedItem);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type(movedNestedItem);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type(movedChildItem);

  await dragBlockTextAboveText(page, editor, movedNestedItem, secondRootItem);

  await expect.poll(() => readEditorDirectListItems(editor)).toEqual([firstRootItem, movedNestedItem, secondRootItem]);
  await expect.poll(() => readEditorNestedListItems(editor)).toEqual([movedChildItem]);
  await expect(page.locator("[data-block-drop-indicator='true']")).toHaveCount(0);
});

test("block handle outdents a nested list item when dragged left", async ({ page }) => {
  const parentItem = "Parent row";
  const nestedItem = "Nested row to pull left";
  const editor = await createNewDocument(page, `List level drag ${Date.now()}`);

  await page.keyboard.type("- ");
  await page.keyboard.type(parentItem);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type(nestedItem);

  await dragBlockTextLeft(page, editor, nestedItem);

  await expect.poll(() => readEditorDirectListItems(editor)).toEqual([parentItem, nestedItem]);
  await expect.poll(() => readEditorNestedListItems(editor)).toEqual([]);
  await expect(page.locator("[data-block-drop-indicator='true']")).toHaveCount(0);
});

test("block handle moves a list item out to a top-level block position", async ({ page }) => {
  const anchorText = "Paragraph above the list.";
  const firstItem = "List item that stays in the original list";
  const secondItem = "List item that moves above the paragraph";
  const editor = await createNewDocument(page, `List split drag ${Date.now()}`);

  await page.keyboard.type(anchorText);
  await page.keyboard.press("Enter");
  await page.keyboard.type("- ");
  await page.keyboard.type(firstItem);
  await page.keyboard.press("Enter");
  await page.keyboard.type(secondItem);

  await dragBlockTextAboveText(page, editor, secondItem, anchorText);

  await expect.poll(() => readTopLevelEditorTags(editor).then((tags) => tags.slice(0, 3))).toEqual(["UL", "P", "UL"]);
  await expect.poll(() => readEditorListItems(editor)).toEqual([secondItem, firstItem]);
  await expect(page.locator("[data-block-drop-indicator='true']")).toHaveCount(0);
});

test("block handle moves markdown block variants above a paragraph", async ({ page }) => {
  const scenarios = [
    {
      expectedFirstTag: "H1",
      option: /제목 1/,
      query: "h1",
      sourceText: "Movable heading block",
      title: "heading",
    },
    {
      expectedFirstTag: "BLOCKQUOTE",
      option: /인용/,
      query: "quote",
      sourceText: "Movable quote block",
      title: "quote",
    },
    {
      expectedFirstTag: "PRE",
      option: /코드 블록/,
      query: "code",
      sourceText: "const movable = true;",
      title: "code",
    },
  ] as const;

  for (const scenario of scenarios) {
    const anchorText = `${scenario.title} anchor paragraph`;
    const editor = await createNewDocument(page, `Markdown drag ${scenario.title} ${Date.now()}`);

    await page.keyboard.type(anchorText);
    await page.keyboard.press("Enter");
    await runSlashCommand(page, scenario.query, scenario.option);
    await page.keyboard.type(scenario.sourceText);

    await dragBlockTextAboveText(page, editor, scenario.sourceText, anchorText);

    await expect.poll(() => readTopLevelEditorTags(editor).then((tags) => tags[0])).toBe(scenario.expectedFirstTag);
    await expect(page.locator("[data-block-drop-indicator='true']")).toHaveCount(0);
  }
});

test("block handle moves a divider with a visible drop indicator", async ({ page }) => {
  const anchorText = "Divider anchor paragraph";
  const editor = await createNewDocument(page, `Divider drag ${Date.now()}`);

  await page.keyboard.type(anchorText);
  await page.keyboard.press("Enter");
  await runSlashCommand(page, "divider", /구분선/);

  const divider = editor.locator("hr");
  await expect(divider).toBeVisible();
  await dragBlockElementAboveText(page, editor, divider, anchorText);

  await expect.poll(() => readTopLevelEditorTags(editor).then((tags) => tags[0])).toBe("HR");
  await expect(page.locator("[data-block-drop-indicator='true']")).toHaveCount(0);
});

test("pastes markdown pipe tables as editable tables", async ({ page }) => {
  const editor = await createNewDocument(page, `Markdown table ${Date.now()}`);
  const markdownTable = [
    "| 구분 | 기술 |",
    "| --- | --- |",
    "| LLM | OpenAI GPT API / Claude API |",
    "| NLP | RAG(Retrieval-Augmented Generation) |",
    "| 임베딩 모델 | Qwen3-Embedding-8B |",
    "| Vector Search | pgvector / ChromaDB |",
  ].join("\n");

  await pastePlainText(editor, markdownTable);

  await expect(editor.locator("table")).toBeVisible();
  await expect(editor.locator("table tr")).toHaveCount(5);
  await expect(editor.locator("table tr").first().locator("th")).toHaveText(["구분", "기술"]);
  await expect(editor.locator("table tr").nth(1).locator("td")).toHaveText(["LLM", "OpenAI GPT API / Claude API"]);
  await expect(editor).not.toContainText("| --- | --- |");
});

async function createNewDocument(page: Page, title: string) {
  await page.goto("/documents");
  await page.getByRole("button", { name: "새 문서" }).click();
  await page.getByRole("textbox", { name: "문서 제목" }).fill(title);

  const editor = page.getByRole("textbox", { name: "문서 본문" });
  await editor.click();
  return editor;
}

async function runSlashCommand(page: Page, query: string, optionName: RegExp) {
  await page.keyboard.type(`/${query}`);

  const slashMenu = page.getByRole("listbox", { name: "슬래시 명령" });
  await expect(slashMenu).toBeVisible();
  await slashMenu.getByRole("option", { name: optionName }).click();
}

async function dragBlockTextAboveText(page: Page, editor: Locator, sourceText: string, targetText: string) {
  await dragBlockElementAboveText(page, editor, editor.getByText(sourceText, { exact: true }), targetText);
}

async function dragBlockTextAboveTextInTopLevelRail(page: Page, editor: Locator, sourceText: string, targetText: string) {
  await dragBlockElementAboveText(page, editor, editor.getByText(sourceText, { exact: true }), targetText, "top-level-rail");
}

async function dragBlockElementAboveText(
  page: Page,
  editor: Locator,
  source: Locator,
  targetText: string,
  dropIntent: "list-content" | "top-level-rail" = "list-content",
) {
  const sourceBox = await source.boundingBox();
  const targetBox = await editor.getByText(targetText, { exact: true }).boundingBox();
  const editorBox = await editor.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  expect(editorBox).not.toBeNull();

  await page.mouse.move(sourceBox!.x + 8, sourceBox!.y + sourceBox!.height / 2);

  const dragHandle = page.getByRole("button", { name: "블록 메뉴 열기" });
  const dragHandleBox = await dragHandle.boundingBox();
  expect(dragHandleBox).not.toBeNull();

  await page.mouse.move(dragHandleBox!.x + dragHandleBox!.width / 2, dragHandleBox!.y + dragHandleBox!.height / 2);
  await page.mouse.down();
  const targetX = dropIntent === "top-level-rail" ? editorBox!.x + 8 : targetBox!.x + 24;
  await page.mouse.move(targetX, targetBox!.y + 2, { steps: 8 });

  await expect(page.locator("[data-block-drop-indicator='true']")).toBeVisible();
  await page.mouse.up();
}

async function openBlockMenuForText(page: Page, editor: Locator, text: string) {
  const sourceBox = await editor.getByText(text, { exact: true }).boundingBox();
  expect(sourceBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + 8, sourceBox!.y + sourceBox!.height / 2);
  await page.getByRole("button", { name: "블록 메뉴 열기" }).click();
}

async function dragBlockTextLeft(page: Page, editor: Locator, sourceText: string) {
  const sourceBox = await editor.getByText(sourceText, { exact: true }).boundingBox();
  expect(sourceBox).not.toBeNull();

  await page.mouse.move(sourceBox!.x + 8, sourceBox!.y + sourceBox!.height / 2);

  const dragHandle = page.getByRole("button", { name: "블록 메뉴 열기" });
  const dragHandleBox = await dragHandle.boundingBox();
  expect(dragHandleBox).not.toBeNull();

  const startX = dragHandleBox!.x + dragHandleBox!.width / 2;
  const startY = dragHandleBox!.y + dragHandleBox!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 72, startY, { steps: 8 });
  await expect(page.locator("[data-block-drop-indicator='true']")).toBeVisible();
  await page.mouse.up();
}

async function pastePlainText(editor: Locator, text: string) {
  await editor.evaluate((element, clipboardText) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", clipboardText);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, text);
}

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

async function readBrowserSelection(page: Page) {
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

async function readEditorParagraphs(editor: Locator) {
  return editor.evaluate((element) =>
    Array.from(element.querySelectorAll("p"))
      .map((paragraph) => paragraph.textContent?.trim() ?? "")
      .filter(Boolean),
  );
}

async function readTopLevelParagraphs(editor: Locator) {
  return editor.evaluate((element) =>
    Array.from(element.children)
      .filter((child) => child.tagName === "P")
      .map((paragraph) => paragraph.textContent?.trim() ?? "")
      .filter(Boolean),
  );
}

async function readEditorListItems(editor: Locator) {
  return editor.evaluate((element) =>
    Array.from(element.querySelectorAll("li"))
      .map((listItem) => listItem.textContent?.trim() ?? "")
      .filter(Boolean),
  );
}

async function readEditorDirectListItems(editor: Locator) {
  return editor.evaluate((element) => {
    const topLevelList = Array.from(element.children).find((child) => child.matches("ul, ol"));
    if (!topLevelList) return [];

    return Array.from(topLevelList.children)
      .map((listItem) => Array.from(listItem.childNodes).find((child) => child.nodeName === "P")?.textContent?.trim() ?? "")
      .filter(Boolean);
  });
}

async function readTopLevelListItemsByList(editor: Locator) {
  return editor.evaluate((element) =>
    Array.from(element.children)
      .filter((child) => child.matches("ul, ol"))
      .map((list) =>
        Array.from(list.children)
          .map((listItem) => Array.from(listItem.childNodes).find((child) => child.nodeName === "P")?.textContent?.trim() ?? "")
          .filter(Boolean),
      ),
  );
}

async function readEditorNestedListItems(editor: Locator) {
  return editor.evaluate((element) => {
    const nestedList = element.querySelector("li > ul, li > ol");
    if (!nestedList) return [];

    return Array.from(nestedList.children)
      .map((listItem) => Array.from(listItem.childNodes).find((child) => child.nodeName === "P")?.textContent?.trim() ?? "")
      .filter(Boolean);
  });
}

async function readSelectedListItemText(page: Page) {
  return page.evaluate(() => {
    const selection = window.getSelection();
    const anchorNode = selection?.anchorNode;
    const anchorElement =
      anchorNode instanceof HTMLElement
        ? anchorNode
        : anchorNode?.parentElement instanceof HTMLElement
          ? anchorNode.parentElement
          : null;
    return anchorElement?.closest("li")?.textContent?.trim() ?? "";
  });
}

async function readTopLevelEditorTags(editor: Locator) {
  return editor.evaluate((element) => Array.from(element.children).map((child) => child.tagName));
}

async function readNonEmptyTopLevelEditorTags(editor: Locator) {
  return editor.evaluate((element) =>
    Array.from(element.children)
      .filter((child) => child.tagName !== "P" || (child.textContent?.trim() ?? "").length > 0)
      .map((child) => child.tagName),
  );
}
