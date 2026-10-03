# Turbo API Test Mocks

[MSW](https://mswjs.io/) handlers for the Turbo endpoints the CLI reaches through Turbo SDK 2.x. Tests run the real SDK against these, so a change in what the SDK sends is caught here rather than in production.

Every handler answers a route the SDK actually calls; check the SDK source (`node_modules/@ardrive/turbo-sdk/lib/esm/common`) before adding one. A mock for a route the SDK no longer calls lets a test pass while production breaks.

`tests/setup.ts` loads the defaults for every test and **fails any request no handler answers**, so a test can never reach a live service by accident.

<!-- toc -->

- [Default handlers](#default-handlers)
- [Overriding them](#overriding-them)
- [Types](#types)

<!-- tocstop -->

## Default handlers

- **Upload service** (`upload.ardrive.io`)
  - `GET /`: service info, including `freeUploadLimitBytes` and `gateway`
  - `POST /v1/tx/:token`: a signed data item
- **Payment service** (`payment.ardrive.io`)
  - `GET /v1/account/balance/:token`: balance, including `effectiveBalance`
  - `GET /v1/account/free`: the wallet's remaining free-tier bytes (`null` is unlimited)
  - `GET /v1/price/bytes/:byteCount`: price of one data item
  - `GET /v1/price/:token/:amount`: credits for a token amount
  - `POST /v1/account/balance/:token`: submit a fund transaction (credited)
- **Gateway** (`turbo-gateway.com`)
  - `POST /graphql`: past uploads for `--incremental` (none)

## Overriding them

```typescript
import { http, HttpResponse } from 'msw'

import { mockInsufficientBalance } from '../mocks/turbo-handlers.js'
import { server } from '../setup.js'

it('refuses an upload the balance cannot cover', async () => {
  server.use(...mockInsufficientBalance('100', '99999999999'))
  // ...
})

it('sees what the bundler received', async () => {
  server.use(
    http.post('https://upload.ardrive.io/v1/tx/:token', ({ request }) => {
      // e.g. request.headers.get('x-paid-by')
      return HttpResponse.json({ id: 'a'.repeat(43) })
    }),
  )
  // ...
})
```

`tests/unit/payments-workflow.test.ts` has a fuller harness (`turboAt`) that mocks a whole upload and payment service pair, production or sandbox, and records the traffic.

## Types

Response types come from the OpenAPI specs in `tests/fixtures/`. After updating a spec, regenerate them:

```bash
pnpm generate:types
```
