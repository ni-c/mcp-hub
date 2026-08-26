# Demo recording for the README and the docs landing page.
#
# The tape assumes a RUNNING hub — setup belongs in the docs, not the shop
# window. Prepare before recording (see the repo history for the exact steps):
#   - local image `mcp-hub:demo` = ghcr image + four official MCP servers
#     installed globally (memory, filesystem, everything, sequential-thinking)
#   - config/mcp.json with those four servers, ./data owned by uid 1000
#   - an API token for /hub in ./token.txt (minted offline)
#   - ./headers with the two transport headers (Content-Type: application/json
#     and Accept: application/json, text/event-stream), pulled in via `-H @headers`
#   - container up on :7690 and all four servers 'up' in /health
# Then record from that directory:  vhs /path/to/docs/demo.tape
#
# Gotcha from the first version: inside Hide blocks use vhs's own Sleep —
# a shell `sleep` blocks the prompt while vhs keeps typing, and the tape
# ends before any output appears.

Output demo.gif

Set FontSize 17
Set Width 1080
Set Height 620
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 30ms
Set Shell bash

Hide
Type `export TOKEN=$(cat token.txt); clear`
Enter
Show

Type "# one config — many MCP servers"
Enter
Type "cat config/mcp.json"
Enter
Sleep 3.5s

Type "# one endpoint — six meta-tools"
Enter
Type `curl -s localhost:7690/hub -H "Authorization: Bearer $TOKEN" -H @headers -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_servers","arguments":{}}}' | jq -r '.result.content[0].text'`
Enter
Sleep 5s

Type "# per-server health"
Enter
Type `curl -s localhost:7690/health -H "Authorization: Bearer $TOKEN" | jq -c '.servers | map_values(.state)'`
Enter
Sleep 6s
