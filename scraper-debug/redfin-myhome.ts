import dotenv from 'dotenv'; dotenv.config();
import { createStealthContext } from '../src/stealth/context-factory.js';
import { closeBrowser } from '../src/stealth/browser.js';
import { gaussianDelay } from '../src/stealth/human.js';

const LANDING_URL = 'https://www.redfin.com/what-is-my-home-worth';
// placeholder="Enter your address" is unique to the main landing form (not header nav inputs)
const SEARCH_BOX = 'input[placeholder="Enter your address"]';
// The main page's "Next" submit button
const SUBMIT_BUTTON = 'button.button.Button.primary';

async function testRedfinSeoPage(address: string) {
  const ctx = await createStealthContext();
  const page = await ctx.newPage();
  try {
    // Quick Google hop first, then land on SEO page
    console.log('[redfin] Hitting google.com...');
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await gaussianDelay(page, 600, 150);

    console.log('[redfin] Navigating to SEO landing page:', LANDING_URL);
    await page.goto(LANDING_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await gaussianDelay(page, 2500, 400);

    console.log('[redfin] Title:', await page.title());
    console.log('[redfin] URL:', page.url());

    // Dismiss OneTrust cookie banner if present
    const allowAll = await page.$('button:has-text("Allow All"), #onetrust-accept-btn-handler');
    if (allowAll) {
      console.log('[redfin] Dismissing cookie banner...');
      await allowAll.click({ timeout: 5000 }).catch(() => {});
      await gaussianDelay(page, 600, 100);
    }

    // Confirm search box is present
    const boxEl = await page.$(SEARCH_BOX);
    if (!boxEl) {
      console.log('[redfin] ERROR: search box not found — probing inputs...');
      const inputs = await page.$$eval('input', (els) =>
        els.map((i) => ({
          type: i.getAttribute('type'),
          placeholder: i.getAttribute('placeholder'),
          id: i.id,
          testname: i.getAttribute('data-rf-test-name'),
        }))
      );
      console.log('[redfin] Inputs on page:', JSON.stringify(inputs, null, 2));
      return;
    }
    console.log('[redfin] Search box found');

    // Check submit button is present
    const submitEl = await page.$(SUBMIT_BUTTON);
    console.log('[redfin] Submit button found:', !!submitEl);

    // Click then fill address (paste strategy)
    await page.click(SEARCH_BOX);
    await gaussianDelay(page, 400, 80);
    await page.fill(SEARCH_BOX, address);
    console.log('[redfin] Filled address:', address);
    await gaussianDelay(page, 600, 100);

    // Click the submit button
    if (!submitEl) {
      console.log('[redfin] ERROR: submit button not found');
      return;
    }
    console.log('[redfin] Clicking submit button...');
    await submitEl.click();

    // Wait for result page
    console.log('[redfin] Waiting for result page...');
    await page.waitForTimeout(8000);

    const finalUrl = page.url();
    const finalTitle = await page.title();
    console.log('\n[redfin] Final URL:', finalUrl);
    console.log('[redfin] Final title:', finalTitle);

    const body = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 1000)).catch(() => '');
    console.log('[redfin] Body:\n', body);

    // Price selector probe
    const priceSelectors = [
      '.AvmSection .price',
      '[data-rf-test-name="avmValue"]',
      '[data-rf-test-id="avm-price"]',
      '.HomeInfoV2 .price',
      '.avm-price',
      '[class*="avm" i]',
      '[class*="estimate" i]',
      '[class*="Estimate"]',
    ];
    console.log('\n[redfin] Price selector probe:');
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
    console.log('\n[redfin] JSON-LD count:', jsonLd.length);
    for (const j of jsonLd.slice(0, 3)) console.log('[redfin]  -', j.slice(0, 250));

    // Dump all data-rf-test-id / data-rf-test-name elements
    const rfTestEls = await page.$$eval('[data-rf-test-id], [data-rf-test-name]', (els) =>
      els.slice(0, 30).map((e) => ({
        testid: e.getAttribute('data-rf-test-id'),
        testname: e.getAttribute('data-rf-test-name'),
        text: e.textContent?.trim().slice(0, 80),
      }))
    ).catch(() => []);
    console.log('\n[redfin] data-rf-test-* elements (first 30):');
    for (const t of rfTestEls) console.log(`  [${t.testid ?? t.testname}]: ${t.text}`);

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
