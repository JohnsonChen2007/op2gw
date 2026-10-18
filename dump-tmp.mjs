import http from 'node:http'
import fs from 'node:fs'

const OUT = '/var/folders/nh/2bkxnh3j0gs8qr9f8stjvqq00000gn/T/opencode/captured.json'
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    fs.writeFileSync(OUT, JSON.stringify({ method: req.method, url: req.url, headers: req.headers, bodyRaw: raw }, null, 2))
    console.log('captured', raw.length, 'bytes ->', OUT)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: [DONE]\n\n')
  })
})
server.listen(18923, '127.0.0.1', () => console.log('dump server on 127.0.0.1:18923'))
