// A stdio MCP server with two tools, for tests of what hydra's launch settings let a session call: `harmless` and `unsafe_tool` (stand-ins for a browser server's tools).
// Each answers "RAN <name>" when it is called. No other behaviour.
let buf = ''
process.stdin.on('data', d => {
  buf += d
  let i: number
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    let m: any; try { m = JSON.parse(line) } catch { continue }
    const reply = (result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n')
    if (m.method === 'initialize') reply({ protocolVersion: m.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } })
    else if (m.method === 'tools/list') reply({ tools: ['harmless', 'unsafe_tool'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) })
    else if (m.method === 'tools/call') reply({ content: [{ type: 'text', text: `RAN ${m.params?.name}` }] })
    else if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\n')
  }
})
