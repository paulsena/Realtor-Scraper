import { createStealthContext } from './src/stealth/context-factory.js';
import { closeBrowser } from './src/stealth/browser.js';
import { navigateWithReferrer } from './src/stealth/human.js';

async function checkSite(name: string, url: string, searchSel: string, address: string) {
  const ctx = await createStealthContext();
  const page = await ctx.newPage();
  try {
    await navigateWithReferrer(page, url);
    await page.waitForTimeout(3000);
    
    const found = await page.$(searchSel);
    if (!found) { console.log(`[${name}] Search box NOT FOUND: ${searchSel}`); return; }
    console.log(`[${name}] Search box found`);
    
    // Use page.focus + page.type for reliable input triggering
    await page.focus(searchSel);
    await page.waitForTimeout(300);
    await page.type(searchSel, address, { delay: 80 });
    await page.waitForTimeout(3000);
    
    // Dump everything visible that appeared
    const dump = await page.evaluate(() => {
      const all = document.querySelectorAll('*');
      const results: object[] = [];
      for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.height === 0 || rect.width === 0) continue;
        const tag = el.tagName.toLowerCase();
        if (!['li','ul','div','span','a'].includes(tag)) continue;
        const text = el.textContent?.trim().substring(0, 60) ?? '';
        if (!text) continue;
        const id = el.id;
        const cls = el.className?.substring?.(0, 80) ?? '';
        const testid = el.getAttribute('data-testid');
        const role = el.getAttribute('role');
        // Only include things that look like dropdown/suggestion items
        if (
          cls.match(/suggest|autocomplete|typeahead|result|SearchMenu|dropdown|menu|item|option/i) ||
          role === 'option' || role === 'listbox' ||
          testid?.match(/suggest|result|item|search/i) ||
          id.match(/suggest|result|search-box-result/i)
        ) {
          results.push({ tag, id, cls, role, testid, text });
        }
      }
      return results.slice(0, 30);
    });
    console.log(`[${name}] Dropdown candidates after typing:`, JSON.stringify(dump, null, 2));
  } catch(e: any) {
    console.log(`[${name}] Error:`, e.message?.substring(0, 300));
  } finally {
    await ctx.close();
  }
}

async function main() {
  await checkSite('zillow', 'https://www.zillow.com/', 'input[type="text"][aria-label*="Search"]', '26 E Chestnut');
  await checkSite('redfin', 'https://www.redfin.com/', 'input#search-box-input', '26 E Chestnut');
  await closeBrowser();
}

main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
