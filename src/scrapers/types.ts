import type { BrowserContext, Page } from 'rebrowser-playwright';

export interface ScrapeResult {
  status: 'success' | 'timeout' | 'error' | 'blocked';
  estimatedPrice?: number;
  details?: {
    beds?: number;
    baths?: number;
    sqft?: number;
    yearBuilt?: number;
    lotSize?: string;
  };
  salesHistory?: Array<{ date: string; price: number; event: string }>;
  taxHistory?: Array<{ year: number; tax: number; assessment: number }>;
  comparables?: Array<{
    address: string;
    price: number;
    beds?: number;
    baths?: number;
    sqft?: number;
  }>;
  error?: string;
}

export interface Scraper {
  readonly name: string;
  readonly landingUrl: string;
  scrape(
    context: BrowserContext,
    address: string,
    timeoutMs: number,
    landingPage?: Page,
  ): Promise<ScrapeResult>;
}
