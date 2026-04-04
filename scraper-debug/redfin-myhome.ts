import { createStealthContext } from './src/stealth/context-factory.js';
import { closeBrowser } from './src/stealth/browser.js';
import { navigateWithReferrer, gaussianDelay, humanClick } from './src/stealth/human.js';

async function testMyHomeValueFull(address: string) {
  const ctx = await createStealthContext();
  const page = await ctx.newPage();
  try {
    await navigateWithReferrer(page, 'https://www.redfin.com/');
    await gaussianDelay(page, 2000, 300);

    await page.goto('https://www.redfin.com/what-is-my-home-worth', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await gaussianDelay(page, 3000, 400);

    console.log('[redfin] Title:', await page.title());

    // Type into the dedicated "Enter your address" input
    await page.click('input[placeholder="Enter your address"]');
    await page.waitForTimeout(400);
    await page.type('input[placeholder="Enter your address"]', address, { delay: 80 });
    console.log('[redfin] Typed address');

    // Wait for autocomplete
    console.log('[redfin] Waiting for .item-row.clickable...');
    await page.waitForSelector('.item-row.clickable', { timeout: 8000 });
    console.log('[redfin] Autocomplete appeared!');
    await gaussianDelay(page, 500, 100);

    // Click first result
    await humanClick(page, '.item-row.clickable');
    console.log('[redfin] Clicked autocomplete result');

    // Wait for navigation / estimate page
    await page.waitForTimeout(6000);

    const finalUrl = page.url();
    const title = await page.title();
    console.log('[redfin] Final URL:', finalUrl);
    console.log('[redfin] Final title:', title);

    const body = await page.evaluate(() => (document.body?.innerText ?? '').substring(0, 800)).catch(() => '');
    console.log('[redfin] Body:\n', body);

    // Check for price elements
    const priceSelectors = [
      '[data-rf-test-id="avm-price"]',
      '.statsValue',
      '.HomeStats',
      '.HomeInfoV2 .price',
      '.avm-price',
      '.EstimateSection .value',
      '[class*="avm"]',
      '[class*="estimate" i]',
    ];
    for (const sel of priceSelectors) {
      const el = await page.$(sel);
      if (el) {
        const text = await el.textContent();
        console.log(`[redfin] Price selector "${sel}": ${text?.trim()}`);
      }
    }

    // Check JSON-LD
    const jsonLd = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map(s => s.textContent?.substring(0, 300) ?? '')
    ).catch(() => []);
    console.log('[redfin] JSON-LD count:', jsonLd.length);
    for (const j of jsonLd.slice(0, 3)) console.log('[redfin]  -', j.substring(0, 250));

  } catch(e: any) {
    console.log('[redfin] Error:', e.message?.substring(0, 300));
    console.log('[redfin] Current URL:', page.url());
  } finally {
    await ctx.close();
  }
}

async function main() {
  await testMyHomeValueFull('26 E Chestnut St Asheville NC 28801');
  await closeBrowser();
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
