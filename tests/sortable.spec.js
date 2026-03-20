// @ts-check
import { test, expect } from "@playwright/test";

/**
 * Simulate a drag from one element to another using mouse events. Moves in small steps to trigger
 * the drag threshold and reorder logic.
 *
 * @param {import("@playwright/test").Page} page
 * @param {import("@playwright/test").Locator} from
 * @param {import("@playwright/test").Locator} to
 */
async function drag(page, from, to) {
  // Scroll into view before reading coordinates
  await from.scrollIntoViewIfNeeded();

  const fromBox = await from.boundingBox();
  const toBox = await to.boundingBox();
  if (!fromBox || !toBox) throw new Error("Could not get bounding boxes");

  const sx = fromBox.x + fromBox.width / 2;
  const sy = fromBox.y + fromBox.height / 2;
  const ex = toBox.x + toBox.width / 2;
  const ey = toBox.y + toBox.height / 2;

  await page.mouse.move(sx, sy);
  await page.mouse.down();

  // Move in steps to cross drag threshold and trigger reorder.
  // Use enough steps for smooth movement that the rAF-based
  // updateCurrentIndex can detect intermediate positions.
  const steps = 15;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(sx + ((ex - sx) * i) / steps, sy + ((ey - sy) * i) / steps);
    // Small pause every few steps to let rAF fire
    if (i % 5 === 0) await page.waitForTimeout(50);
  }

  // Hold at destination for rAF-based detection (cross-container, reorder)
  await page.waitForTimeout(150);
  await page.mouse.up();

  // Wait for drop animation to settle
  await page.waitForTimeout(250);
}

// ---- Alpine.js tests (test.html) ----

test.describe("Alpine.js - test.html", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/test.html");
    // Wait for Alpine to initialize
    await page.waitForSelector("[data-sortable]");
  });

  test("1. basic list reorder", async ({ page }) => {
    const container = page.locator("h2:has-text('1. Basic sortable') + div");
    const items = container.locator("[data-sortable]");

    await expect(items).toHaveCount(5);
    const before = await items.allTextContents();
    expect(before).toEqual(["Apple", "Banana", "Cherry", "Date", "Elderberry"]);

    // Drag Apple (index 0) to Cherry's position (index 2)
    await drag(page, items.nth(0), items.nth(2));

    const after = await items.allTextContents();
    expect(after).not.toEqual(before);
    // Apple should have moved down
    expect(after.indexOf("Apple")).toBeGreaterThan(0);

    // Log should show something was moved
    const log = container.locator(".log");
    await expect(log).not.toHaveText("");
  });

  test("2. handles - drag from handle works", async ({ page }) => {
    const container = page.locator("h2:has-text('2. With handles') + div");
    const items = container.locator("[data-sortable]");
    const handles = container.locator("[data-sortable-handle]");

    const before = await items.allTextContents();

    // Drag from handle of first item to handle of third item
    await drag(page, handles.nth(0), handles.nth(2));

    const after = await items.allTextContents();
    expect(after).not.toEqual(before);
  });

  test("2. handles - drag from item body does NOT work", async ({ page }) => {
    const container = page.locator("h2:has-text('2. With handles') + div");
    const items = container.locator("[data-sortable]");

    const before = await items.allTextContents();

    // Click on the text span (not the handle) and try to drag
    const textSpan = items.nth(0).locator("span:not([data-sortable-handle])");
    await drag(page, textSpan, items.nth(2));

    const after = await items.allTextContents();
    expect(after).toEqual(before); // Should NOT have moved
  });

  test("3. disabled items cannot be dragged", async ({ page }) => {
    const container = page.locator("h2:has-text('3. With disabled item') + div");
    const items = container.locator("[data-sortable]");

    const before = await items.allTextContents();
    const disabledItem = items.nth(1); // "Pinned (disabled)"

    // Try to drag the disabled item
    await drag(page, disabledItem, items.nth(3));

    const after = await items.allTextContents();
    expect(after).toEqual(before); // Nothing should move
  });

  test("3. non-disabled items can be reordered", async ({ page }) => {
    const container = page.locator("h2:has-text('3. With disabled item') + div");
    const items = container.locator("[data-sortable]");

    const before = await items.allTextContents();

    // Drag Movable B (index 2) to Movable C (index 3)
    await drag(page, items.nth(2), items.nth(3));

    const after = await items.allTextContents();
    expect(after).not.toEqual(before);

    // The log should confirm a reorder happened
    const log = container.locator(".log");
    await expect(log).not.toHaveText("");
  });

  test("4. scrollable container auto-scrolls", async ({ page }) => {
    const scrollable = page.locator("h2:has-text('4. Scrollable container') + div .scrollable");
    const items = scrollable.locator("[data-sortable]");

    // Scroll into view first
    await scrollable.scrollIntoViewIfNeeded();

    // Verify scroll is at top
    const scrollBefore = await scrollable.evaluate((el) => el.scrollTop);
    expect(scrollBefore).toBe(0);

    // Start drag on first item
    const firstItem = items.nth(0);
    const fromBox = await firstItem.boundingBox();
    const box = await scrollable.boundingBox();
    if (!fromBox || !box) throw new Error("No bounding box");

    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await page.mouse.down();

    // Move past drag threshold
    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2 + 10);
    await page.waitForTimeout(50);

    // Hold near the bottom edge of the scrollable container.
    // The scroll loop runs on rAF — hold long enough for frames to fire.
    const targetY = box.y + box.height - 2;
    for (let i = 0; i < 50; i++) {
      await page.mouse.move(box.x + box.width / 2, targetY);
      await page.waitForTimeout(20);
    }

    const scrollAfter = await scrollable.evaluate((el) => el.scrollTop);
    expect(scrollAfter).toBeGreaterThan(0);

    await page.mouse.up();
    await page.waitForTimeout(200);
  });

  test("7. kanban cross-container transfer", async ({ page }) => {
    // Alpine kanban: h3 headers label each column
    const todoList = page.locator("h3:has-text('To Do') + ul");
    const doingList = page.locator("h3:has-text('Doing') + ul");

    const todoCount = await todoList.locator("[data-sortable]").count();
    const doingCount = await doingList.locator("[data-sortable]").count();

    // Drag first todo item to the doing column container
    await drag(page, todoList.locator("[data-sortable]").nth(0), doingList);

    // Wait extra for Alpine reactivity
    await page.waitForTimeout(300);

    const todoAfter = await todoList.locator("[data-sortable]").count();
    const doingAfter = await doingList.locator("[data-sortable]").count();

    expect(todoAfter).toBe(todoCount - 1);
    expect(doingAfter).toBe(doingCount + 1);
  });
});

// ---- Preact/hooks tests (test-react.html) ----

test.describe("Preact/hooks - test-react.html", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/test-react.html");
    // Wait for Preact to render (CDN imports may take a moment)
    await page.waitForSelector("[data-sortable]", { timeout: 10000 });
  });

  test("1. basic list reorder", async ({ page }) => {
    const items = page
      .locator("h2:has-text('1. Basic list')")
      .locator("~ div >> nth=0")
      .locator("[data-sortable]");

    await expect(items).toHaveCount(5);
    const before = await items.allTextContents();

    await drag(page, items.nth(0), items.nth(2));

    const after = await items.allTextContents();
    expect(after).not.toEqual(before);
  });

  test("2. handles - drag from handle works", async ({ page }) => {
    const section = page.locator("h2:has-text('2. Drag handles')").locator("~ div >> nth=0");
    const items = section.locator("[data-sortable]");
    const handles = section.locator("[data-sortable-handle]");

    const before = await items.allTextContents();

    await drag(page, handles.nth(0), handles.nth(2));

    const after = await items.allTextContents();
    expect(after).not.toEqual(before);
  });

  test("2. handles - drag from item body does NOT work", async ({ page }) => {
    const section = page.locator("h2:has-text('2. Drag handles')").locator("~ div >> nth=0");
    const items = section.locator("[data-sortable]");

    const before = await items.allTextContents();

    // Drag from the item text area, not the handle
    const firstItem = items.nth(0);
    await drag(page, firstItem, items.nth(2));

    const after = await items.allTextContents();
    expect(after).toEqual(before);
  });

  test("3. disabled items cannot be dragged", async ({ page }) => {
    const section = page.locator("h2:has-text('3. Disabled items')").locator("~ div >> nth=0");
    const items = section.locator("[data-sortable]");

    const before = await items.allTextContents();
    await drag(page, items.nth(1), items.nth(3)); // disabled item

    const after = await items.allTextContents();
    expect(after).toEqual(before);
  });

  test("7. kanban cross-container transfer", async ({ page }) => {
    const todoList = page.locator("h3:has-text('To Do') + ul");
    const doingList = page.locator("h3:has-text('Doing') + ul");

    const todoCount = await todoList.locator("[data-sortable]").count();
    const doingCount = await doingList.locator("[data-sortable]").count();

    // Drag first todo item to the doing column container
    await drag(page, todoList.locator("[data-sortable]").nth(0), doingList);

    // Wait extra for Preact reactivity
    await page.waitForTimeout(300);

    const todoAfter = await todoList.locator("[data-sortable]").count();
    const doingAfter = await doingList.locator("[data-sortable]").count();

    expect(todoAfter).toBe(todoCount - 1);
    expect(doingAfter).toBe(doingCount + 1);
  });
});