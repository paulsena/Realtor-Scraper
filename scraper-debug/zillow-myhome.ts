import dotenv from 'dotenv'; dotenv.config();
import { createStealthContext } from '../src/stealth/context-factory.js';
import { closeBrowser } from '../src/stealth/browser.js';
import { gaussianDelay } from '../src/stealth/human.js';

const LANDING_URL = 'https://www.zillow.com/how-much-is-my-home-worth/';
const SEARCH_BOX = 'input[data-testid="address-search-input"]';
// Autocomplete dropdown suggestion list
const AUTOCOMPLETE_ITEM = 'ul[role="listbox"] li[role="option"]';

async function testZillowSeoPage(address: string) {
  const ctx = await createStealthContext();
  const page = await ctx.newPage();
  try {
    // Quick Google hop first, then land on SEO page
    console.log('[zillow] Hitting google.com...');
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await gaussianDelay(page, 600, 150);

    console.log('[zillow] Navigating to SEO landing page:', LANDING_URL);
    await page.goto(LANDING_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await gaussianDelay(page, 2500, 400);

    console.log('[zillow] Title:', await page.title());
    console.log('[zillow] URL:', page.url());

    // Block check
    const title = (await page.title()).toLowerCase();
    if (title.includes('access denied') || title.includes('403')) {
      console.log('[zillow] BLOCKED on landing page');
      console.log('[zillow] Body:', (await page.evaluate(() => document.body.innerText.slice(0, 400))));
      return;
    }

    // Verify search box
    const boxEl = await page.$(SEARCH_BOX);
    if (!boxEl) {
      console.log('[zillow] ERROR: search box not found:', SEARCH_BOX);
      return;
    }
    console.log('[zillow] Search box found');

    // Click and type slowly to trigger Zillow's autocomplete
    await page.click(SEARCH_BOX);
    await gaussianDelay(page, 400, 80);
    console.log('[zillow] Typing address slowly to trigger autocomplete...');
    await page.locator(SEARCH_BOX).pressSequentially(address, { delay: 60 });
    await gaussianDelay(page, 1200, 200);

    // Probe for autocomplete dropdown
    const suggestionEl = await page.$(AUTOCOMPLETE_ITEM);
    if (suggestionEl) {
      console.log('[zillow] Autocomplete dropdown appeared — pressing ArrowDown to select first suggestion');
      await page.keyboard.press('ArrowDown');
      await gaussianDelay(page, 400, 80);
      // Enter selects the highlighted suggestion (populates the input)
      await page.keyboard.press('Enter');
      await gaussianDelay(page, 500, 100);
    } else {
      console.log('[zillow] No autocomplete dropdown visible');
    }

    // Always click the submit button explicitly after autocomplete selection
    const submitBtn = await page.$('button[name="submit-button"]');
    if (submitBtn) {
      console.log('[zillow] Clicking submit button...');
      await submitBtn.click();
    } else {
      console.log('[zillow] WARN: submit button not found');
    }

    // Wait for lightbox / result to load (in-page update, no navigation)
    console.log('[zillow] Waiting for result lightbox...');
    await page.waitForTimeout(8000);

    const finalUrl = page.url();
    const finalTitle = await page.title();
    console.log('\n[zillow] Final URL:', finalUrl);
    console.log('[zillow] Final title:', finalTitle);

    const body = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 1000)).catch(() => '');
    console.log('[zillow] Body:\n', body);

    // Price selector probe — covers listing price, Zestimate, and home value pages
    const priceSelectors = [
      'span[data-testid="price"]',
      'span[data-testid="zestimate-text"]',
      '[data-testid="zestimate"]',
      '[data-testid="home-value"]',
      '[class*="zestimate" i]',
      '[class*="estimate" i]',
      '[class*="home-value" i]',
      '.ds-summary-row .ds-value',
    ];
    console.log('\n[zillow] Price selector probe:');
    for (const sel of priceSelectors) {
      const el = await page.$(sel);
      if (el) {
        const text = await el.textContent();
        console.log(`  FOUND "${sel}": ${text?.trim()}`);
      }
    }

    // JSON-LD
    const jsonLd = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map((s) => s.textContent?.slice(0, 300) ?? '')
    ).catch(() => []);
    console.log('\n[zillow] JSON-LD count:', jsonLd.length);
    for (const j of jsonLd.slice(0, 3)) console.log('[zillow]  -', j.slice(0, 250));

    // Dump all data-testid elements
    const testIds = await page.$$eval('[data-testid]', (els) =>
      els.slice(0, 40).map((e) => ({ testid: e.getAttribute('data-testid'), text: e.textContent?.trim().slice(0, 80) }))
    ).catch(() => []);
    console.log('\n[zillow] data-testid elements (first 40):');
    for (const t of testIds) console.log(`  [${t.testid}]: ${t.text}`);

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('[zillow] Error:', msg.slice(0, 300));
    console.log('[zillow] Current URL:', page.url());
  } finally {
    await ctx.close();
  }
}

async function main() {
  await testZillowSeoPage('26 E Chestnut St Asheville NC 28801');
  await closeBrowser();
}
main().then(() => process.exit(0)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
