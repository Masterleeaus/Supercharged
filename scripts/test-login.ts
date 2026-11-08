import fetch from 'node-fetch';

const BASE_URL = 'https://callcenter.cloudams.com';
const EMAIL = 'info@cloudsoftwaretech.com';
const PASSWORD = 'Delta2026!@#$';

async function testAuth() {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: EMAIL, email: EMAIL, password: PASSWORD }),
  });
  console.log('Status:', res.status);
  console.log('Headers:', res.headers.raw());
  const bodyText = await res.text();
  console.log('Body:', bodyText);
}

testAuth();
