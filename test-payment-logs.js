const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/user/payment-logs/some-user-id?limit=10&offset=0',
  method: 'GET',
  headers: {
    'x-internal-api-key': process.env.INTERNAL_API_KEY || 'test' // Need to provide a valid one if checking auth, but let's see what happens
  }
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Headers:', res.headers);
    console.log('Body:', data);
  });
});

req.on('error', (e) => {
  console.error(`Problem with request: ${e.message}`);
});
req.end();
