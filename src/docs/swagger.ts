import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Realtor Scraper API',
      version: '1.0.0',
      description:
        'Scrapes property valuations from Zillow, Redfin, and Realtor.com in parallel. ' +
        'Results are cached in SQLite to avoid redundant scrapes. ' +
        'Each scraper runs with an independent timeout; if one site fails or times out, ' +
        'the others still return results. ' +
        'Authenticate with an X-API-Key header on protected endpoints.',
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
        },
      },
    },
  },
  apis: ['./src/routes/*.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
