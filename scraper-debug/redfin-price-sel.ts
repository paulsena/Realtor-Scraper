import { createStealthContext } from './src/stealth/context-factory.js';
import { closeBrowser } from './src/stealth/browser.js';
import { navigateWithReferrer, gaussianDelay, humanClick } from './src/stealth/human.js';

async function findPriceSelectors(address: string) {
  const ctx = await createStealthContext();
  const page = await ctx.newPage();
  try {
    await navigateWithReferrer(page, 'https://www.redfin.com/');
    await gaussianDelay(page, 2000, 300);
    await page.goto('https://www.redfin.com/what-is-my-home-worth', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await gaussianDelay(page, 3000, 400);

    await page.click('input[placeholder="Enter your address"]');
    await page.waitForTimeout(400);
    await page.type('input[placeholder="Enter your address"]', address, { delay: 80 });
    await page.waitForSelector('.item-row.clickable', { timeout: 8000 });
    await gaussianDelay(page, 500, 100);
    await humanClick(page, '.item-row.clickable');
    await page.waitForTimeout(6000);

    console.log('[redfin] URL:', page.url());

    // Dump all elements whose text starts with a dollar amount
    const priceEls = await page.evaluate(() => {
      const all = document.querySelectorAll('*');
      const results: any[] = [];
      for (const el of all) {
        const children = el.children.length;
        const text = (el as HTMLElement).innerText?.trim() ?? '';
        if (!text.startsWith('$') || children > 3) continue;
        const tag = el.tagName.toLowerCase();
        const cls = (el.className?.toString() ?? '').substring(0, 100);
        const testid = el.getAttribute('data-rf-test-id') ?? el.getAttribute('data-testid');
        const id = el.id;
        results.push({ tag, id, cls, testid, text: text.substring(0, 60) });
      }
      return results.slice(0, 20);
    });
    console.log('[redfin] Elements starting with $:', JSON.stringify(priceEls, null, 2));

    // Also probe specific selectors
    const candidates = [
      '[data-rf-test-id="avm-price"]',
      '.avm-price',
      '.avmSection .price',
      '.AvmSection .price',
      '.homevalue-price',
      '.avmPrice',
      '[class*="avmPrice"]',
      '[class*="avm-price"]',
      '[class*="AvmPrice"]',
      '.estimate .price',
      '.Estimate .price',
    ];
    for (const sel of candidates) {
      const el = await page.$(sel);
      if (el) {
        const text = await el.evaluate((e: HTMLElement) => e.innerText?.trim());
        console.log(`[redfin] "${sel}": ${text?.substring(0, 50)}`);
      }
    }

    // Also look at the estimate section structure
    const estimateSection = await page.evaluate(() => {
      const sels = ['[class*="estimateSection" i]', '[class*="AvmSection"]', '[class*="avmSection"]', '[class*="HomeValueSection"]'];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el) {
          return {
            sel,
            outerHTML: el.outerHTML.substring(0, 600),
          };
        }
      }
      return null;
    });
    if (estimateSection) console.log('[redfin] Estimate section:', JSON.stringify(estimateSection, null, 2));

  } catch(e: any) {
    console.log('[redfin] Error:', e.message?.substring(0, 300));
  } finally {
    await ctx.close();
  }
}

async function main() {
  await findPriceSelectors('26 E Chestnut St Asheville NC 28801');
  await closeBrowser();
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
