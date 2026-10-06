# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-07

First release. Built from the Checkbox OpenAPI document version 2.108.3; not yet verified against the live API.

### Added

- stdio MCP server, started with `npx -y @myradostudio/checkbox-mcp`, configured with environment variables.
- Sign-in with a cashier PIN code and license key, or with login and password. The token is kept in memory, renewed once after an HTTP 401 and revoked on disconnect.
- 16 read-only tools: `get_cashier_profile`, `list_cash_registers`, `get_cash_register`, `get_offline_status`, `get_current_shift`, `list_shifts`, `get_shift`, `search_receipts`, `get_receipt`, `list_reports`, `get_report`, `get_periodical_report`, `search_goods`, `list_taxes`, `list_orders`, `get_order`.
- 7 write tools, registered only with `CHECKBOX_ALLOW_WRITE=1`: `open_shift`, `close_shift`, `create_sale_receipt`, `create_return_receipt`, `create_service_receipt`, `send_receipt_email`, `send_receipt_sms`.
- Request timeout, pagination with a default of 25 and a cap of 100, API errors returned as tool errors with the message of the API.
- `server.json` for the MCP registry.
- Tests with a mocked HTTP layer that check every request against a snapshot of the official OpenAPI document, and an end-to-end test over stdio.

[0.1.0]: https://github.com/myradostudio/checkbox-mcp/releases/tag/v0.1.0
