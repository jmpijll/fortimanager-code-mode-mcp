# Troubleshooting Guide

Common issues and solutions for the FortiManager Code Mode MCP Server.

---

## Connection Issues

### `FMG Transport Error: HTTP 503 Service Unavailable`

**Cause**: FortiManager is temporarily unavailable or overwhelmed with requests.

**Solutions**:

- Wait a few seconds and retry
- Check FortiManager VM status — is it running?
- Reduce request frequency (the server has a 50-call-per-execution limit)

### `FMG Transport Error: connect ECONNREFUSED`

**Cause**: Cannot reach the FortiManager host.

**Solutions**:

- Verify `FMG_HOST` is correct (include `https://`)
- Check network connectivity: `curl -k https://<host>/jsonrpc`
- Verify `FMG_PORT` (default: 443)

### `FMG Transport Error: self-signed certificate`

**Cause**: FortiManager uses a self-signed SSL certificate.

**Solution**: Set `FMG_VERIFY_SSL=false` in your configuration.

### `FMG Transport Error: request timed out`

**Cause**: FortiManager didn't respond within the 30-second timeout.

**Solutions**:

- Check FortiManager load and responsiveness
- Simplify the query (reduce data volume)
- Check network latency to the FortiManager host

---

## Authentication Issues

### `status.code: -11` (No Permission)

**Cause**: The API token doesn't have permission for the requested operation.

**Solutions**:

- Verify the API token has the correct admin profile
- For read operations, the token needs at least "Read Only" access
- For write operations (add/set/delete), the token needs "Read-Write" access
- Some endpoints require "Super Admin" privileges
- Check the ADOM assignment — tokens may be scoped to specific ADOMs

### `status.code: -13` (Session Expired)

**Cause**: Rare with API tokens (more common with session-based auth).

**Solution**: Restart the MCP server to re-establish the connection.

---

## Sandbox Errors

### `SyntaxError: expecting ';'` or `SyntaxError: unexpected token`

**Cause**: JavaScript syntax error in the sandbox code.

**Common mistakes**:

- Using `await` — API calls are synchronous in the sandbox, no `await` needed
- Using `const` with re-declarations — use `var` instead
- Arrow function syntax issues in QuickJS — use `function()` syntax for compatibility

**Correct pattern**:

```javascript
// ✓ Correct
var resp = fortimanager.request("get", [{ url: "/sys/status" }]);

// ✗ Wrong — SyntaxError
const resp = await fortimanager.request("get", [{ url: "/sys/status" }]);
```

### `Error: Method not allowed: <method>`

**Cause**: The sandbox only allows specific FortiManager methods.

**Allowed methods**: `get`, `set`, `add`, `update`, `delete`, `exec`, `clone`, `move`, `replace`

### `Error: Code input too large`

**Cause**: Code exceeds the 100 KB limit.

**Solution**: Break the code into smaller queries.

### `Error: API call limit exceeded (50 calls per execution)`

**Cause**: The sandbox limits each execution to 50 FortiManager API calls.

**Solution**: Break the work into multiple `execute` tool calls.

---

## API Response Issues

### `status.code: -6` (Invalid URL)

**Cause**: The URL path doesn't match any FortiManager API endpoint.

**Solutions**:

- Use the `search` tool first to find the correct URL
- Check URL path format: `/dvmdb/adom`, `/pm/config/adom/root/obj/firewall/address`
- Replace `{adom}` placeholders with actual ADOM names (e.g., `root`)

### `status.code: -2` (Object Already Exists)

**Cause**: Trying to `add` an object with a name that already exists.

**Solutions**:

- Use `set` or `update` instead of `add` to modify existing objects
- Delete the existing object first, then `add`
- Check if the object exists with `get` before creating

### Empty `data` in Response

**Cause**: The query returned no results, or the object/table is empty.

**Solutions**:

- Verify the URL is correct
- Check ADOM name in the URL
- Try without filters to see if any data exists
- Use `option: "count"` to check if there are any records

---

## Server Startup Issues

### `API SPEC NOT FOUND`

**Cause**: The API spec files have not been generated. They are **not included** in this repository and must be generated locally.

**Solution**:
1. Download the FortiManager JSON API Reference HTML docs from [FNDN](https://fndn.fortinet.net)
2. Place them in `docs/api-reference/` (see [README](../README.md#important-api-spec-required) for exact folder structure)
3. Run `npm run generate:spec`
4. Run `npm run build`

### `ENOENT: no such file or directory, open '.../dist/spec/fmg-api-spec-7.6.json'`

**Cause**: Spec files weren't copied to `dist/spec/` during build, or haven't been generated yet.

**Solution**: Run `npm run generate:spec` first, then `npm run build` — the build script copies spec files automatically.

### `Error: Spec file not found or invalid`

**Cause**: The `FMG_API_VERSION` doesn't match an available spec file.

**Available versions**: `7.4` or `7.6`

### `Rate limited: 429 Too Many Requests`

**Cause**: More than 60 requests per minute from the same IP (HTTP transport only).

**Solution**: Reduce request frequency. The limit resets after 60 seconds.

---

## MCP Protocol Issues

### `406 Not Acceptable: Client must accept both application/json and text/event-stream`

**Cause**: A Streamable HTTP `POST /mcp` request must accept both response types — JSON and SSE.

**Solution**: Send `Accept: application/json, text/event-stream` on every request to `/mcp`. MCP SDK clients do this for you.

### `Invalid params: the MCP-Protocol-Version header names protocol revision 2026-07-28 ...`

**Cause**: A hand-written request claims the 2026-07-28 revision through the `MCP-Protocol-Version` header but is missing the per-request `_meta` envelope (`io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientInfo`, `io.modelcontextprotocol/clientCapabilities`).

**Solution**: Use an MCP client of revision 2026-07-28, or drop the header — requests without it take the 2025-era `initialize` path. Hand-written requests that claim the header must carry the full envelope in `params._meta`.

### `Unsupported protocol version` on a modern client

**Cause**: The client pins a revision the server does not serve. This server serves protocol revision 2026-07-28 and the 2025-era handshake (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07).

**Solution**: Pin 2026-07-28 or leave version negotiation at its default. No server configuration selects an era.

---

## Docker Issues

### Health Check Failing

**Cause**: Container started but server isn't ready yet.

**Solutions**:

- Wait for the `start_period` (10 seconds) to pass
- Check container logs: `docker logs fortimanager-code-mode-mcp`
- Verify environment variables in `.env` file

### Container Exits Immediately

**Cause**: Missing required environment variables.

**Required**: `FMG_HOST` and `FMG_API_TOKEN`

**Solution**: Create a `.env` file with all required variables:

```bash
FMG_HOST=https://your-fmg-host
FMG_API_TOKEN=your-api-token
FMG_VERIFY_SSL=false
```

---

## FortiManager Permission Matrix

| Operation                       | Required Permission       |
| ------------------------------- | ------------------------- |
| `get /sys/status`               | Any valid token           |
| `get /dvmdb/device`             | Device Manager (Read)     |
| `get /dvmdb/adom`               | Any valid token           |
| `get /pm/config/adom/.../obj/*` | Policy & Objects (Read)   |
| `add/set/delete` objects        | Policy & Objects (Write)  |
| `exec /sys/proxy/json`          | Device Manager (Read)     |
| `exec /dvmcmd/...`              | Device Manager (Write)    |
| `get /cli/global/system/*`      | System Settings (Read)    |
| Script execution                | Script Access + Super     |
| Install policy package          | Policy & Objects (Write)  |

---

## Getting Help

1. Check the [FortiManager JSON-RPC API Reference](https://docs.fortinet.com/document/fortimanager) for endpoint details
2. Use the `search` tool to explore available URLs, attributes, and methods
3. Look up error codes: `errorCodes.filter(function(e) { return e.code === <code>; })`
4. File a [GitHub Issue](https://github.com/jmpijll/fortimanager-code-mode-mcp/issues) with:
   - Error message and stack trace
   - FortiManager version (`/sys/status`)
   - MCP server version
   - Steps to reproduce
