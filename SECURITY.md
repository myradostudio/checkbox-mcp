# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Write to **hello@myradostudio.com** with a description, the affected version and, if you can, steps to reproduce.

Never include real credentials, license keys, tokens or customer data in a report. If a secret has been exposed, first change the cashier password or reset the PIN code in the Checkbox personal cabinet (Checkbox documents that either one invalidates the cashier's tokens), and ask Checkbox support about the license key.

## Supported versions

Only the latest published version receives fixes.

## What the server does with your data

- Credentials (`CHECKBOX_LOGIN`, `CHECKBOX_PASSWORD`, `CHECKBOX_PIN_CODE`, `CHECKBOX_LICENSE_KEY`) are read from environment variables and sent only to the API origin in `CHECKBOX_API_URL` (by default `https://api.checkbox.ua`). Plain `http://` is refused for anything but localhost.
- The access token is kept in memory only and is revoked when the MCP client disconnects, on a best-effort basis.
- Nothing is written to disk. stderr receives startup messages and the type of a transport error; requests, responses, tokens and credentials are never logged. There is no telemetry.
- Tool results go to the MCP client and from there to the AI model you use. Full receipts and orders can contain customer contact data.

## Things to keep in mind

- `CHECKBOX_ALLOW_WRITE=1` lets the connected AI model create fiscal documents on your behalf. Keep per-call confirmation enabled in your MCP client, and prefer a test cashier until you trust the setup.
- Your MCP client stores the environment variables you give it, usually in a plain-text configuration file. Protect that file like any other credential store.
- Text stored in Checkbox (names of goods, comments, order notes) is passed to the model unchanged and can carry prompt-injection attempts.
- This is an unofficial project. It is not affiliated with or endorsed by Checkbox.
