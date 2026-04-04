import { chromium, type Browser } from 'rebrowser-playwright';
import { loadConfig } from '../config.js';

let browserInstance: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  const config = loadConfig();

  browserInstance = await chromium.launch({
    channel: 'chrome',
    headless: false,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--webrtc-ip-handling-policy=default_public_interface_only',
      '--disable-features=IsolateOrigins,site-per-process',
      '--no-sandbox',
    ],
    proxy: config.proxyUrl ? { server: config.proxyUrl } : undefined,
  });

  return browserInstance;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}
