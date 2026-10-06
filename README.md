# checkbox-mcp

An [MCP](https://modelcontextprotocol.io) server for the API of [Checkbox](https://checkbox.ua), a Ukrainian software cash register (ПРРО). It lets an AI assistant such as Claude answer questions about receipts, shifts, X/Z reports, goods and orders of your organization, and, only if you explicitly allow it, open and close shifts and create fiscal receipts.

Українською: [README.uk.md](README.uk.md)

> **Unofficial.** This project is not affiliated with or endorsed by Checkbox. "Checkbox" is a trademark of its owner. Use it at your own risk: receipts created through the write tools are real fiscal documents.

> **Status: 0.1.0, not yet verified on a live cash register.** The server is built from the official [OpenAPI document](https://api.checkbox.ua/api/openapi.json) (version 2.108.3) and the public [Checkbox wiki](https://wiki.checkbox.ua/uk/api). All tests run against a mocked HTTP layer and check every request against a snapshot of that OpenAPI document. Nobody has run it against the real Checkbox API yet, neither with a test cashier nor with a production one. See [Limitations](#limitations).

## What is a ПРРО, and what is Checkbox?

In Ukraine most businesses that sell to consumers have to register each sale with the State Tax Service (ДПС). The device or program that does this is a "registrar of settlement operations" (РРО). A **ПРРО** is the software variant: instead of a certified hardware cash register, a program signs every receipt with the cashier's electronic signature, sends it to the tax service and gets a fiscal number back. Work is organized in **shifts** (зміна): a cashier opens a shift, issues receipts, and closes the shift with a **Z-report**, the daily summary that goes to the tax service. **Checkbox** is one such ПРРО service; it offers web and mobile apps and a REST API, which is what this server talks to.

## Quick start

You need Node.js 20 or newer and the credentials of a Checkbox cashier. To try the server out, use the **test cashier and test cash register** that Checkbox creates for every account (see [Trying it with Checkbox test data](#trying-it-with-checkbox-test-data)).

### Claude Desktop

Add the server to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "checkbox": {
      "command": "npx",
      "args": ["-y", "@myradostudio/checkbox-mcp"],
      "env": {
        "CHECKBOX_PIN_CODE": "your cashier PIN code",
        "CHECKBOX_LICENSE_KEY": "your cash register license key"
      }
    }
  }
}
```

If the server does not start on Windows, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "@myradostudio/checkbox-mcp"]`.

### Claude Code

```bash
claude mcp add --transport stdio \
  --env CHECKBOX_PIN_CODE=your-pin-code \
  --env CHECKBOX_LICENSE_KEY=your-license-key \
  checkbox -- npx -y @myradostudio/checkbox-mcp
```

### Cursor

Add the same block to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "checkbox": {
      "command": "npx",
      "args": ["-y", "@myradostudio/checkbox-mcp"],
      "env": {
        "CHECKBOX_PIN_CODE": "your cashier PIN code",
        "CHECKBOX_LICENSE_KEY": "your cash register license key"
      }
    }
  }
}
```

Any other MCP client that can start a local stdio server works the same way: run `npx -y @myradostudio/checkbox-mcp` with the environment variables below.

Then ask, for example:

- "Which cashier are you signed in as, and is a shift open?"
- "Show yesterday's receipts and the total by payment form."
- "Find the Z-reports for last week and print the latest one."
- "Is the cash register online? How many offline codes are left?"

## Configuration

The server is configured with environment variables only. It validates them at startup and exits with an explanation on stderr if something is missing.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `CHECKBOX_PIN_CODE` | one sign-in method | | Cashier PIN code. The sign-in method Checkbox recommends. Needs `CHECKBOX_LICENSE_KEY`. |
| `CHECKBOX_LOGIN` | one sign-in method | | Cashier login. Used with `CHECKBOX_PASSWORD` when no PIN code is set. |
| `CHECKBOX_PASSWORD` | with the login | | Cashier password. |
| `CHECKBOX_LICENSE_KEY` | see purpose | | License key of the cash register. Required for PIN sign-in, for write mode, and for the tools that report on "this" cash register (`get_cash_register` without an id, `get_offline_status`, `get_periodical_report`, `list_shifts` with scope `cash_register`). |
| `CHECKBOX_API_URL` | no | `https://api.checkbox.ua` | API origin. Must be `https://` (plain `http://` is accepted for localhost only). |
| `CHECKBOX_ALLOW_WRITE` | no | off | Set to `1` to register the write tools. Any other value than `1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off` stops the server. |

The PIN code and the license key are shown in the Checkbox personal cabinet, in the cashier and cash register sections. If both a PIN code and a login/password pair are set, the PIN code is used.

## Tools

Money amounts are integers in **kopecks** (13550 means 135.50 UAH) and quantities are integers in **thousandths** (1000 means 1 piece, 2250 means 2.25 kg), exactly as in the Checkbox API. The server tells the model so.

### Read tools (always available)

| Tool | What it returns | API call |
| --- | --- | --- |
| `get_cashier_profile` | The signed-in cashier, permissions, test flag, and the organization | `GET /api/v1/cashier/me` |
| `list_cash_registers` | Cash registers with fiscal number, address, online/offline mode, open shift | `GET /api/v1/cash-registers` |
| `get_cash_register` | One cash register by id, or the one the license key belongs to | `GET /api/v1/cash-registers/{id}` or `GET /api/v1/cash-registers/info` |
| `get_offline_status` | Available offline fiscal codes and time spent offline | `GET /api/v1/cash-registers/get-offline-codes-count` and `…/get-offline-time` |
| `get_current_shift` | The open shift of the cashier with its running balance | `GET /api/v1/cashier/shift` |
| `list_shifts` | Shifts of the cashier, or of the cash register | `GET /api/v1/shifts` or `GET /api/v1/cash-registers/shifts` |
| `get_shift` | One shift in full, including its Z-report once closed | `GET /api/v1/shifts/{id}` |
| `search_receipts` | Receipts by period, fiscal number, barcode, shift, cash register, branch | `GET /api/v1/receipts/search` |
| `get_receipt` | One receipt as JSON, or as printable text | `GET /api/v1/receipts/{id}` or `…/{id}/text` |
| `list_reports` | X- and Z-reports with totals per payment form | `GET /api/v1/reports/search` |
| `get_report` | One report as JSON, or as printable text | `GET /api/v1/reports/{id}` or `…/{id}/text` |
| `get_periodical_report` | The periodical report for a date range, as text | `GET /api/v1/reports/periodical` |
| `search_goods` | Goods from the Checkbox catalogue with prices and tax rates | `GET /api/v1/goods` |
| `list_taxes` | Tax rates configured for the organization | `GET /api/v1/cashier/tax` |
| `list_orders` | Orders (draft receipts placed by an external system) | `GET /api/v1/orders` |
| `get_order` | One order in full, including customer delivery details | `GET /api/v1/orders/{id}` |

List tools return compact summaries and a `pagination` block. The page size defaults to 25 and is capped at 100 (50 for cash register shifts, the limit of that endpoint); `next_offset` tells the model how to continue.

### Write tools (only with `CHECKBOX_ALLOW_WRITE=1`)

| Tool | What it does | API call |
| --- | --- | --- |
| `open_shift` | Opens a shift on the cash register of the license key | `POST /api/v1/shifts` |
| `close_shift` | Closes the current shift and creates its Z-report | `POST /api/v1/shifts/close` |
| `create_sale_receipt` | Creates and fiscalizes a sale receipt | `POST /api/v1/receipts/sell` |
| `create_return_receipt` | Creates and fiscalizes a return receipt | `POST /api/v1/receipts/sell` with `is_return` on every line |
| `create_service_receipt` | Puts cash into the register or takes it out | `POST /api/v1/receipts/service` |
| `send_receipt_email` | E-mails a copy of a receipt | `POST /api/v1/receipts/{id}/email` |
| `send_receipt_sms` | Sends a copy of a receipt by SMS/Viber (a Checkbox service billed separately) | `POST /api/v1/receipts/{id}/sms` |

**A receipt is a fiscal document. Once created it cannot be edited or deleted; a mistake can only be compensated with a separate return receipt.** The same goes for an opened or closed shift.

## Safety model

Fiscal receipts are legal documents, so the server is conservative by design.

- **Read-only unless you opt in.** Without `CHECKBOX_ALLOW_WRITE=1` the write tools are not registered at all: the model cannot see or call them. Every read tool issues only `GET` requests, and a test enforces that.
- **Honest annotations.** Read tools carry `readOnlyHint: true`. Tools that create fiscal state (`open_shift`, `close_shift`, the three receipt tools) carry `destructiveHint: true`: strictly speaking they add data, but the result cannot be undone, and the hint is what makes MCP clients ask you for confirmation. No write tool claims to be idempotent. Whether and how confirmation is shown is up to your MCP client; keep per-call approval switched on for the write tools.
- **Strict input for writes.** Write tools reject unknown fields, non-integer amounts and malformed contacts before anything is sent, so a misspelled `discount` cannot silently produce a receipt with the wrong total.
- **No blind retries.** The server never repeats a write on its own, except once after an HTTP 401, where the request was refused for authentication and a fresh token is needed. If a write times out, the tool says that the outcome is unknown and how to check it. Every new receipt gets a UUID up front; Checkbox documents that it rejects a receipt whose id already exists, so a retry with that id cannot create a duplicate.
- **No bypass of Checkbox's own checks.** `close_shift` does not expose the option that skips the check that a shift is closed by the program that opened it.
- **Credentials stay local.** They are read from environment variables, used only for requests to `CHECKBOX_API_URL`, and never written to stdout, stderr or tool results. The access token lives in memory and is revoked when the MCP client disconnects (best effort: a killed process cannot do that).
- **Less data to the model.** List tools return summaries without customer contacts; the cashier's personal tax number is removed from every result. `get_receipt` and `get_order` do return full records, which can contain customer e-mail addresses, phone numbers and delivery addresses.
- **No telemetry, no logging of business data.** stderr gets only startup messages (configuration problems and a one-line banner with the mode) and the type of a transport error. Requests and responses are never logged.

Two things the server cannot do for you. First, whatever a tool returns is sent to the AI model you use and to its provider; decide whether that is acceptable for your data. Second, names of goods, comments and other text stored in Checkbox reach the model as-is and could contain instructions written by someone else (prompt injection). That is one more reason to approve every write call yourself.

## Trying it with Checkbox test data

This is what Checkbox documents; this project has **not** been run against it yet.

- There is no separate sandbox host. According to the [wiki](https://wiki.checkbox.ua/uk/api), `https://api.checkbox.ua` is the single address for both testing and fiscal work. What makes a session a test is the cashier and the cash register you sign in with.
- A **test cashier** and a **test cash register** appear in the Checkbox personal cabinet automatically after registration ([wiki: test data](https://wiki.checkbox.ua/uk/portal/test-data)). Test receipts are not sent to the tax service and are marked as test receipts. Checkbox limits them to 100 per month.
- For the test cashier the password is the same as the login ([wiki: authorization](https://wiki.checkbox.ua/uk/api/auth)).
- Checkbox warns never to use a production cashier or cash register for testing: incorrect data sent to the tax service has to be explained and can lead to a fine.

A reasonable first session: configure the server with the test cashier, leave `CHECKBOX_ALLOW_WRITE` unset, and call `get_cashier_profile`. It should show `is_test: true`. Only then consider write mode, with the test credentials.

## Limitations

- **Not verified against the live API.** Requests are checked against the OpenAPI document, which describes shapes, not behaviour. Response handling, error texts and the asynchronous status flow are implemented from the documentation.
- **One cashier per server instance**, and one cash register for the tools that need the license key.
- **Not covered:** offline mode operations (going offline/online, offline receipts), creating X-reports, prepayment and post-payment receipts, currency exchange, invoices and acquiring terminals, editing goods, delivery-service waybills (ЕТТН), webhooks, extended reports, receipt templates.
- **`search_receipts` cannot filter by status or type**, because the API has no such parameter; the tool returns both fields for each receipt. By default the API returns only receipts created by the signed-in cashier.
- **Fiscalization is asynchronous.** A new receipt or shift comes back in status `CREATED`; the model has to poll `get_receipt` or `get_current_shift`. The server does not wait.
- **In a return receipt, payments are sent as positive amounts.** The OpenAPI document does not spell this out; it has to be confirmed on a test cash register.
- **No totals for most lists.** The API reports a total only for orders, so the server can only say that there may be a next page.
- **Rate limits are not enforced by the server.** Checkbox documents a limit of two new receipts per second per cash register (exceeding it blocks the register for 5 seconds) and blocks repeated views of the same receipt at three requests per second.
- **Tokens.** Checkbox documents at most three valid tokens per cashier. The server signs in once per start and signs out on disconnect, but a cashier who is also signed in elsewhere may be affected.
- **Do not mix programs within a shift.** Checkbox warns that a shift opened through the API must not be operated from the Checkbox Kasa or Manager apps at the same time.
- **Fixed 30-second timeout** per request.

## Development

```bash
npm install
npm run lint          # tsc --noEmit over src/ and tests/
npm test              # builds dist/ and the tests, then runs them with node:test
npm run spec:update   # refreshes the OpenAPI snapshot from api.checkbox.ua
```

- `src/endpoints.ts` is the catalogue of API operations the server calls. `tests/spec.test.ts` compares it with `spec/checkbox-api.snapshot.json`, a reduced copy of the official OpenAPI document (parameters, request schemas and security of those operations only).
- Every tool test calls the tool through a real MCP client and passes each recorded request through `assertMatchesSpec`, which checks the path, query parameters, headers and body against that snapshot.
- `tests/e2e.test.ts` starts the built server as a child process over stdio against a local HTTP mock.
- To poke at the server by hand: `npx @modelcontextprotocol/inspector node dist/index.js`.

The server uses the official TypeScript SDK ([`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server)) and `zod`; there are no other runtime dependencies.

Issues and pull requests are welcome. For security reports see [SECURITY.md](SECURITY.md).

## Built by

Built and maintained by [Myrado Studio](https://myradostudio.com) — custom MCP servers, AI agents and automation. Need an MCP server for your own system? https://myradostudio.com/en/mcp-server-development/

## License

[MIT](LICENSE) © 2026 Myrado Studio
