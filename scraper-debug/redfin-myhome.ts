import dotenv from 'dotenv'; dotenv.config();
import { createStealthContext } from '../src/stealth/context-factory.js';
import { closeBrowser } from '../src/stealth/browser.js';
import { navigateWithReferrer, gaussianDelay } from '../src/stealth/human.js';

const LANDING_URL = 'https://www.redfin.com/what-is-my-home-worth';
const SEARCH_BOX = 'input[placeholder="Enter your address"], input#search-box-input';
const SUBMIT_BUTTON = 'button:has-text("Next"), button[data-rf-test-id="submit-button"], button[type="submit"]';

async function testRedfinSeoPage(address: string) {
  const ctx = await createStealthContext();
  const page = await ctx.newPage();
  try {
    // Google hop → landing page (same path as production warmup)
    console.log('[redfin] Navigating via Google →', LANDING_URL);
    await navigateWithReferrer(page, LANDING_URL);
    await gaussianDelay(page, 2000, 300);

    console.log('[redfin] Title:', await page.title());
    console.log('[redfin] URL:', page.url());

    // Confirm search box is present
    const boxEl = await page.$(SEARCH_BOX);
    if (!boxEl) {
      console.log('[redfin] ERROR: search box not found — selector may be stale');
      console.log('[redfin] Body snippet:', (await page.evaluate(() => document.body.innerText.slice(0, 400))));
      return;
    }
    console.log('[redfin] Search box found');

    // Paste address all at once
    await page.click(SEARCH_BOX);
    await gaussianDelay(page, 300, 80);
    await page.fill(SEARCH_BOX, address);
    console.log('[redfin] Filled address:', address);
    await gaussianDelay(page, 500, 100);

    // Find and click submit button
    const btnEl = await page.$(SUBMIT_BUTTON);
    if (!btnEl) {
      console.log('[redfin] ERROR: submit button not found — probing page for buttons...');
      const buttons = await page.$$eval('button', (els) =>
        els.map((b) => ({ text: b.textContent?.trim(), type: b.getAttribute('type'), testid: b.getAttribute('data-rf-test-id') }))
      );
      console.log('[redfin] Buttons on page:', JSON.stringify(buttons, null, 2));
      return;
    }
    console.log('[redfin] Submit button found, clicking...');
    await btnEl.click();

    // Wait for results page
    await page.waitForTimeout(6000);

    const finalUrl = page.url();
    const finalTitle = await page.title();
    console.log('[redfin] Final URL:', finalUrl);
    console.log('[redfin] Final title:', finalTitle);

    const body = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 800)).catch(() => '');
    console.log('[redfin] Body:\n', body);

    // Check for price elements
    const priceSelectors = [
      '.AvmSection .price',
      '[data-rf-test-name="avmValue"]',
      '.statsValue [data-rf-test-id="avm-price"]',
      '.HomeInfoV2 .price',
      '[data-rf-test-id="avm-price"]',
      '.avm-price',
      '[class*="avm" i]',
      '[class*="estimate" i]',
    ];
    console.log('\n[redfin] Price selector probe:');
    for (const sel of priceSelectors) {
      const el = await page.$(sel);
      if (el) {
        const text = await el.textContent();
        console.log(`  FOUND "${sel}": ${text?.trim()}`);
      }
    }

    // Check JSON-LD
    const jsonLd = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map((s) => s.textContent?.slice(0, 300) ?? '')
    ).catch(() => []);
    console.log('\n[redfin] JSON-LD count:', jsonLd.length);
    for (const j of jsonLd.slice(0, 3)) console.log('[redfin]  -', j.slice(0, 250));

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('[redfin] Error:', msg.slice(0, 300));
    console.log('[redfin] Current URL:', page.url());
  } finally {
    await ctx.close();
  }
}

async function main() {
  await testRedfinSeoPage('26 E Chestnut St Asheville NC 28801');
  await closeBrowser();
}
main().then(() => process.exit(0)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
