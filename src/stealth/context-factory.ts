import { type BrowserContext } from 'rebrowser-playwright';
import { FingerprintGenerator } from 'fingerprint-generator';
import { newInjectedContext } from 'fingerprint-injector';
import { getBrowser } from './browser.js';

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1680, height: 1050 },
] as const;

const US_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
] as const;

function randomElement<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

const fingerprintGenerator = new FingerprintGenerator();

export async function createStealthContext(): Promise<BrowserContext> {
  const browser = await getBrowser();

  const { fingerprint, headers } = fingerprintGenerator.getFingerprint({
    browsers: ['chrome'],
    operatingSystems: ['windows', 'macos'],
    devices: ['desktop'],
  });

  const viewport = randomElement(VIEWPORTS);
  const timezoneId = randomElement(US_TIMEZONES);

  const context = await newInjectedContext(browser, {
    fingerprint: { fingerprint, headers },
    newContextOptions: {
      viewport: { width: viewport.width, height: viewport.height },
      timezoneId,
    },
  });

  return context;
}
