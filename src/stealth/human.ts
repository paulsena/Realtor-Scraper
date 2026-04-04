import { type Page } from 'rebrowser-playwright';
import { createCursor } from 'ghost-cursor-playwright';

/**
 * Generate a gaussian-distributed delay using the Box-Muller transform.
 */
export async function gaussianDelay(
  page: Page,
  mean: number,
  stddev: number,
): Promise<void> {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const delay = Math.max(0, Math.round(mean + z * stddev));
  await page.waitForTimeout(delay);
}

/**
 * Type text into a selector with human-like gaussian delays between keystrokes.
 */
export async function humanType(
  page: Page,
  selector: string,
  text: string,
): Promise<void> {
  await page.click(selector);
  for (const char of text) {
    await page.keyboard.type(char);
    await gaussianDelay(page, 80, 20);
  }
}

/**
 * Scroll the page smoothly in small increments with random delays.
 */
export async function smoothScroll(
  page: Page,
  distance: number,
): Promise<void> {
  let scrolled = 0;
  while (scrolled < distance) {
    const increment = Math.floor(Math.random() * 41) + 20; // 20-60px
    const step = Math.min(increment, distance - scrolled);
    await page.mouse.wheel(0, step);
    scrolled += step;
    const delay = Math.floor(Math.random() * 51) + 30; // 30-80ms
    await page.waitForTimeout(delay);
  }
}

/**
 * Click a selector using ghost-cursor bezier-curve mouse movement.
 */
export async function humanClick(
  page: Page,
  selector: string,
): Promise<void> {
  try {
    // Cast needed: rebrowser-playwright's Page vs playwright-core's Page
    const cursor = await createCursor(page as never);
    await cursor.actions.click({ target: selector });
  } catch {
    // ghost-cursor can fail due to rebrowser-playwright frame context differences;
    // fall back to a direct click
    await page.click(selector);
  }
}

/**
 * Navigate to a URL via a Google hop so document.referrer is authentically set.
 * Visits google.com first (domcontentloaded only — fast), then navigates to the target.
 */
export async function navigateWithReferrer(
  page: Page,
  url: string,
): Promise<void> {
  await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await gaussianDelay(page, 700, 150);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}
