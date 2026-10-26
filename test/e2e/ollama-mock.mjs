import http from 'node:http';

let requests = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/_health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    return;
  }
  if (req.method === 'GET' && req.url === '/_count') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ requests }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/api/chat') {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    requests += 1;
    let body;
    try { body = JSON.parse(raw); } catch {
      res.writeHead(400).end('invalid json');
      return;
    }
    const toolCall = Array.isArray(body.tools) && body.tools.length > 0;
    const model = body.model ?? 'test-model';
    const message = toolCall
      ? { role: 'assistant', content: '', tool_calls: [{ function: { name: body.tools[0].function.name, arguments: { ok: true } } }] }
      : { role: 'assistant', content: `mock:${model}` };
    const now = new Date().toISOString();
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'transfer-encoding': 'chunked' });
      res.write(`${JSON.stringify({ model, created_at: now, message: { role: 'assistant', content: message.content }, done: false })}\n`);
      res.end(`${JSON.stringify({ model, created_at: now, message: { role: 'assistant', content: '' }, done: true, total_duration: 1000, eval_count: 1 })}\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model, created_at: now, message, done: true, total_duration: 1000, eval_count: 1 }));
  });
});
server.listen(11434, '0.0.0.0');
