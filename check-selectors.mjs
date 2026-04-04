import { createStealthContext } from './src/stealth/context-factory.js';


async function checkSite(name, url, address) {
  const ctx = await createStealthContext();
  const page = await ctx.newPage();
  try {
    await page.setExtraHTTPHeaders({ Referer: 'https://www.google.com/' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
    
    const inputs = await page.$$eval('input', els => els.map(e => ({
      id: e.id, placeholder: e.placeholder,
      'aria-label': e.getAttribute('aria-label'),
      'data-testid': e.getAttribute('data-testid'),
      type: e.type
    })));
    console.log(`[${name}] Inputs:`, JSON.stringify(inputs));
    
    // Try to find and type in search box
    const searchSels = [
      'input[type="text"][aria-label*="Search"]',
      'input#search-box-input',
      'input[data-testid="freeTypeInput"]',
      'input[placeholder*="Search"]',
      'input[placeholder*="address"]',
      'input[placeholder*="Address"]',
    ];
    let input = null;
    let usedSel = null;
    for (const sel of searchSels) {
      input = await page.$(sel);
      if (input) { usedSel = sel; break; }
    }
    if (!input) { console.log(`[${name}] No input found`); return; }
    console.log(`[${name}] Using selector: ${usedSel}`);
    
    await input.click();
    for (const ch of address) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(70);
    }
    await page.waitForTimeout(2500);
    
    const candidates = await page.evaluate(() => {
      const seen = new Set();
      const results = [];
      const selectors = [
        '[role="listbox"]', '[role="option"]', '[role="combobox"]',
        '[class*="autocomplete"]', '[class*="suggestion"]',
        '[class*="dropdown"]', '[class*="result"]', '[class*="typeahead"]',
        '[class*="SearchMenu"]', '[class*="search-menu"]',
        'ul[id*="search"]', 'li[id*="search"]',
        '[data-testid*="suggestion"]', '[data-testid*="result"]',
        '[data-testid*="search"]',
      ];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (seen.has(el)) continue;
          seen.add(el);
          results.push({
            sel, tag: el.tagName, id: el.id,
            class: el.className?.substring?.(0, 80),
            role: el.getAttribute('role'),
            'data-testid': el.getAttribute('data-testid'),
            text: el.textContent?.substring(0, 80)?.trim(),
            visible: el.getBoundingClientRect().height > 0
          });
        }
      }
      return results.slice(0, 20);
    });
    console.log(`[${name}] Autocomplete:`, JSON.stringify(candidates, null, 2));
  } catch(e) {
    console.log(`[${name}] Error:`, e.message.substring(0, 200));
  } finally {
    await ctx.close();
  }
}

await checkSite('zillow', 'https://www.zillow.com/', '26 E Chestnut St');
await checkSite('redfin', 'https://www.redfin.com/', '26 E Chestnut St');
await checkSite('realtor', 'https://www.realtor.com/', '26 E Chestnut St');

