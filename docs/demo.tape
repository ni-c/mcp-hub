# Demo recording for the README and the docs landing page.
# Rebuild with:  cd <scratch-demo-dir> && vhs /path/to/docs/demo.tape
# Prerequisites: mcp.json (everything server via npx), ./data owned by uid
# 1000, image ghcr.io/ni-c/mcp-hub tagged locally, port 7690 free.

Output demo.gif

Set FontSize 16
Set Width 1080
Set Height 640
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set Shell bash

Hide
Type "docker rm -f mcp-hub >/dev/null 2>&1; clear"
Enter
Show

Type "# one config file — exactly Claude Code's mcpServers format"
Enter
Type "cat mcp.json"
Enter
Sleep 3s

Type "# mint an API token for clients that can't do OAuth (ChatGPT & Claude use the built-in OAuth login instead)"
Enter
Type `TOKEN=$(docker run --rm -v "$PWD/data:/data" -e EXTERNAL_URL=http://localhost:7690 ghcr.io/ni-c/mcp-hub:0.6.0 node /app/dist/admin.js tokens create --resource hub --days 90 --label demo)`
Enter
Sleep 4s

Type "# start the hub"
Enter
Type `docker run -d --name mcp-hub -p 7690:80 -e EXTERNAL_URL=http://localhost:7690 -e PASSWORD=demo -v "$PWD/mcp.json:/config/mcp.json:ro" -v "$PWD/data:/data" ghcr.io/ni-c/mcp-hub:0.6.0`
Enter
Sleep 2s

# vhs sleeps while hidden; the shell stays free, so the child server has time
# to come up without a blocking `sleep` eating the rest of the tape.
Hide
Sleep 20s
Type "clear"
Enter
Show

Type "# every server behind one endpoint, four meta-tools"
Enter
Type `curl -s -X POST localhost:7690/hub -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_servers","arguments":{}}}' | jq -r '.result.content[0].text'`
Enter
Sleep 5s

Type "# per-server state at a glance"
Enter
Type `curl -s localhost:7690/health -H "Authorization: Bearer $TOKEN" | jq`
Enter
Sleep 7s

Hide
Type "docker rm -f mcp-hub >/dev/null"
Enter
Sleep 2s
Show
