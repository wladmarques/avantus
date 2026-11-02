'use strict';

/**
 * Cliente da API da SquareCloud (deploy pela API, sem painel).
 * Sobe um servidor HTTP local que imita os endpoints e confere o que é enviado.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { SquareCloudClient, SquareCloudError } = require('../src/services/squarecloudClient');

const APP_ID = '1234567890abcdef12345678';
const TOKEN = 'token-de-teste';

/** Sobe um receptor que responde `responses[method + path]`. */
async function receiver(t, responses = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      calls.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body,
      });
      const key = `${req.method} ${req.url.split('?')[0]}`;
      const reply = responses[key] ?? { status: 200, body: { status: 'success' } };
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return { calls, baseUrl: `http://127.0.0.1:${port}` };
}

const newClient = async (t, responses) => {
  const env = await receiver(t, responses);
  return { ...env, client: new SquareCloudClient({ token: TOKEN, baseUrl: env.baseUrl }) };
};

test('commit envia o zip como multipart com o token da API', async (t) => {
  const { client, calls } = await newClient(t);
  const zip = Buffer.from('PK\u0003\u0004conteudo-do-zip');

  const result = await client.commit(APP_ID, zip, { fileName: 'vantus.zip' });

  assert.equal(result.status, 'success');
  const call = calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `/v2/apps/${APP_ID}/commit`);
  assert.equal(call.authorization, TOKEN);
  assert.match(call.contentType, /multipart\/form-data/);
  const body = call.body.toString('latin1');
  assert.match(body, /name="file"; filename="vantus\.zip"/);
  assert.match(body, /conteudo-do-zip/);
});

test('commit aceita diretório de destino', async (t) => {
  const { client, calls } = await newClient(t);
  await client.commit(APP_ID, Buffer.from('PK'), { path: 'bot' });
  assert.equal(calls[0].url, `/v2/apps/${APP_ID}/commit?path=bot`);
});

test('restart é POST sem corpo', async (t) => {
  const { client, calls } = await newClient(t);
  await client.restart(APP_ID);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `/v2/apps/${APP_ID}/restart`);
  assert.equal(calls[0].body.length, 0);
});

test('deleteFile envia o caminho em JSON', async (t) => {
  const { client, calls } = await newClient(t);
  await client.deleteFile(APP_ID, 'data/vantus.sqlite');
  const call = calls[0];
  assert.equal(call.method, 'DELETE');
  assert.equal(call.url, `/v2/apps/${APP_ID}/files`);
  assert.match(call.contentType, /application\/json/);
  assert.deepEqual(JSON.parse(call.body.toString()), { path: 'data/vantus.sqlite' });
});

test('erro da API vira SquareCloudError com status e código', async (t) => {
  const { client } = await newClient(t, {
    [`POST /v2/apps/${APP_ID}/commit`]: {
      status: 403,
      body: { status: 'error', code: 'MISSING_SCOPE', message: 'Token sem escopo apps:deploy' },
    },
  });

  await assert.rejects(
    () => client.commit(APP_ID, Buffer.from('PK')),
    (error) => {
      assert.ok(error instanceof SquareCloudError);
      assert.equal(error.status, 403);
      assert.equal(error.code, 'MISSING_SCOPE');
      assert.match(error.message, /apps:deploy/);
      return true;
    },
  );
});

test('token ausente falha antes de qualquer requisição', () => {
  assert.throws(() => new SquareCloudClient({ token: '' }), /SQUARECLOUD_TOKEN não configurado/);
});
