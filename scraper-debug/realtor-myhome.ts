import dotenv from 'dotenv'; dotenv.config();
import { createStealthContext } from '../src/stealth/context-factory.js';
import { closeBrowser } from '../src/stealth/browser.js';
import { gaussianDelay } from '../src/stealth/human.js';

const LANDING_URL = 'https://www.realtor.com/myhome';
// Selectors from live page HTML
const SEARCH_BOX = 'input#search-bar';
const SEARCH_BUTTON = 'button[data-testid="autocomplete-top-container--search-button"]';
// Autocomplete dropdown suggestion
const AUTOCOMPLETE_ITEM = '[data-testid="suggestion-item"]';

async function testRealtorMyHomePage(address: string) {
  const ctx = await createStealthContext();
  const page = await ctx.newPage();
  try {
    // Quick Google hop first, then land on SEO page
    console.log('[realtor] Hitting google.com...');
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await gaussianDelay(page, 700, 150);

    console.log('[realtor] Navigating to SEO landing page:', LANDING_URL);
    await page.goto(LANDING_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await gaussianDelay(page, 2500, 400);

    console.log('[realtor] Title:', await page.title());
    console.log('[realtor] URL:', page.url());

    // Kasada / bot detection check
    const titleLc = (await page.title()).toLowerCase();
    const bodyText = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 500)).catch(() => '');
    if (
      titleLc.includes('access denied') ||
      titleLc.includes('403') ||
      bodyText.includes('Your request could not be processed') ||
      bodyText.includes('Reference ID')
    ) {
      console.log('[realtor] BLOCKED (Kasada/bot detection)');
      console.log('[realtor] Body:', bodyText.slice(0, 400));
      return;
    }
    console.log('[realtor] Not blocked — proceeding');

    // Dump inputs and buttons to verify selectors
    const inputs = await page.$$eval('input', (els) =>
      els.map((i) => ({
        id: i.id,
        type: i.getAttribute('type'),
        placeholder: i.getAttribute('placeholder'),
        testid: i.getAttribute('data-testid'),
        role: i.getAttribute('role'),
      }))
    );
    console.log('\n[realtor] Inputs on page:', JSON.stringify(inputs, null, 2));

    const buttons = await page.$$eval('button', (els) =>
      els.map((b) => ({ text: b.textContent?.trim().slice(0, 40), type: b.getAttribute('type'), testid: b.getAttribute('data-testid'), ariaLabel: b.getAttribute('aria-label') }))
    );
    console.log('\n[realtor] Buttons on page:', JSON.stringify(buttons, null, 2));

    // Find search box
    const boxEl = await page.$(SEARCH_BOX);
    if (!boxEl) {
      console.log('[realtor] ERROR: search box not found:', SEARCH_BOX);
      return;
    }
    console.log('\n[realtor] Search box found, clicking then filling...');
    await page.click(SEARCH_BOX);
    await gaussianDelay(page, 400, 80);
    await page.fill(SEARCH_BOX, address);
    console.log('[realtor] Filled:', address);
    await gaussianDelay(page, 800, 150);

    // Check if autocomplete suggestions appeared
    const suggestionEl = await page.$(AUTOCOMPLETE_ITEM);
    if (suggestionEl) {
      const text = await suggestionEl.textContent();
      console.log('[realtor] Autocomplete suggestion appeared:', text?.trim().slice(0, 80));
    } else {
      console.log('[realtor] No autocomplete suggestion appeared');
    }

    // Try clicking the search button (skip autocomplete selection)
    const btnEl = await page.$(SEARCH_BUTTON);
    if (!btnEl) {
      console.log('[realtor] ERROR: search button not found:', SEARCH_BUTTON);
      return;
    }
    console.log('[realtor] Clicking search button...');
    await btnEl.click();

    // Wait for result page
    console.log('[realtor] Waiting for result page...');
    await page.waitForTimeout(8000);

    const finalUrl = page.url();
    const finalTitle = await page.title();
    console.log('\n[realtor] Final URL:', finalUrl);
    console.log('[realtor] Final title:', finalTitle);

    // Bot check on result page
    const resultBody = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 1200)).catch(() => '');
    if (resultBody.includes('Your request could not be processed') || resultBody.includes('Reference ID')) {
      console.log('[realtor] BLOCKED on result page');
      return;
    }
    console.log('[realtor] Body:\n', resultBody.slice(0, 800));

    // Price selector probe
    const priceSelectors = [
      // My Home / property detail page estimates
      '[data-testid="home-value-estimate"]',
      '[data-testid="list-price"]',
      '[data-testid="estimated-value"]',
      '[data-testid="property-price"]',
      '.price-section .price',
      '.summary-price',
      '[class*="estimate" i]',
      '[class*="home-value" i]',
      // Realtor.com "Estimated Value" widget
      '[data-testid="avm"]',
      '[data-testid="avm-value"]',
    ];
    console.log('\n[realtor] Price selector probe:');
    for (const sel of priceSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const text = await el.textContent();
          console.log(`  FOUND "${sel}": ${text?.trim().slice(0, 80)}`);
        }
      } catch { /* ignore */ }
    }

    // JSON-LD
    const jsonLd = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map((s) => s.textContent?.slice(0, 300) ?? '')
    ).catch(() => []);
    console.log('\n[realtor] JSON-LD count:', jsonLd.length);
    for (const j of jsonLd.slice(0, 3)) console.log('[realtor]  -', j.slice(0, 250));

    // __NEXT_DATA__ check
    const nextDataKeys = await page.evaluate(() => {
      const el = document.querySelector('script#__NEXT_DATA__');
      if (!el?.textContent) return null;
      try {
        const d = JSON.parse(el.textContent);
        const props = d?.props?.pageProps;
        return props ? Object.keys(props).slice(0, 20) : Object.keys(d).slice(0, 10);
      } catch { return null; }
    }).catch(() => null);
    console.log('\n[realtor] __NEXT_DATA__ pageProps keys:', nextDataKeys);

    // Dump all data-testid elements to understand page structure
    const testIds = await page.$$eval('[data-testid]', (els) =>
      els.slice(0, 40).map((e) => ({ testid: e.getAttribute('data-testid'), text: e.textContent?.trim().slice(0, 80) }))
    ).catch(() => []);
    console.log('\n[realtor] data-testid elements (first 40):');
    for (const t of testIds) console.log(`  [${t.testid}]: ${t.text}`);

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('[realtor] Error:', msg.slice(0, 300));
    console.log('[realtor] Current URL:', page.url());
  } finally {
    await ctx.close();
  }
}

async function main() {
  await testRealtorMyHomePage('26 E Chestnut St Asheville NC 28801');
  await closeBrowser();
}
main().then(() => process.exit(0)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
