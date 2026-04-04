import dotenv from 'dotenv'; dotenv.config();
import { createStealthContext } from '../src/stealth/context-factory.js';
import { closeBrowser } from '../src/stealth/browser.js';
import { navigateWithReferrer, gaussianDelay } from '../src/stealth/human.js';

const LANDING_URL = 'https://www.zillow.com/how-much-is-my-home-worth/';
const SEARCH_BOX = 'input[aria-label*="address" i], input[placeholder*="address" i], input[id*="search" i]';
const SUBMIT_BUTTON = 'button:has-text("Get started"), button[type="submit"]';

async function testZillowSeoPage(address: string) {
  const ctx = await createStealthContext();
  const page = await ctx.newPage();
  try {
    // Google hop → SEO landing page (same path as production warmup)
    console.log('[zillow] Navigating via Google →', LANDING_URL);
    await navigateWithReferrer(page, LANDING_URL);
    await gaussianDelay(page, 2000, 300);

    console.log('[zillow] Title:', await page.title());
    console.log('[zillow] URL:', page.url());

    // Block check
    const title = (await page.title()).toLowerCase();
    if (title.includes('access denied') || title.includes('403')) {
      console.log('[zillow] BLOCKED on landing page');
      console.log('[zillow] Body:', (await page.evaluate(() => document.body.innerText.slice(0, 400))));
      return;
    }

    // Dump all inputs and buttons to discover selectors
    const inputs = await page.$$eval('input', (els) =>
      els.map((i) => ({
        type: i.getAttribute('type'),
        placeholder: i.getAttribute('placeholder'),
        ariaLabel: i.getAttribute('aria-label'),
        id: i.id,
        name: i.name,
      }))
    );
    console.log('\n[zillow] Inputs on page:', JSON.stringify(inputs, null, 2));

    const buttons = await page.$$eval('button', (els) =>
      els.map((b) => ({ text: b.textContent?.trim(), type: b.getAttribute('type'), testid: b.getAttribute('data-testid') }))
    );
    console.log('\n[zillow] Buttons on page:', JSON.stringify(buttons, null, 2));

    // Try to fill search box
    const boxEl = await page.$(SEARCH_BOX);
    if (!boxEl) {
      console.log('[zillow] Search box not found with selector:', SEARCH_BOX);
      return;
    }
    console.log('\n[zillow] Search box found, filling...');
    await page.click(SEARCH_BOX);
    await gaussianDelay(page, 300, 80);
    await page.fill(SEARCH_BOX, address);
    console.log('[zillow] Filled:', address);
    await gaussianDelay(page, 500, 100);

    // Find and click submit
    const btnEl = await page.$(SUBMIT_BUTTON);
    if (!btnEl) {
      console.log('[zillow] Submit button not found with selector:', SUBMIT_BUTTON);
      return;
    }
    console.log('[zillow] Clicking submit button...');
    await btnEl.click();

    await page.waitForTimeout(6000);

    const finalUrl = page.url();
    const finalTitle = await page.title();
    console.log('\n[zillow] Final URL:', finalUrl);
    console.log('[zillow] Final title:', finalTitle);

    const body = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 800)).catch(() => '');
    console.log('[zillow] Body:\n', body);

    // Price selector probe
    const priceSelectors = [
      'span[data-testid="price"]',
      '.ds-summary-row .ds-value',
      'span[data-testid="zestimate-text"]',
      '[data-testid="zestimate"]',
      '[class*="zestimate" i]',
      '[class*="estimate" i]',
      '[class*="home-value" i]',
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
