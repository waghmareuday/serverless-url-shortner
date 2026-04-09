import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 100 }, // Fast ramp up
    { duration: '20s', target: 100 }, // Sustained load
    { duration: '10s', target: 0 },   // Ramp down
  ],
};

const BASE_URL = 'https://1qlfu0ouhd.execute-api.ap-south-1.amazonaws.com';

export default function () {
  const payload = JSON.stringify({ url: 'https://www.google.com' });
  
  const params = { 
    headers: { 
      'Content-Type': 'application/json'
    } 
  };
  
  const postRes = http.post(`${BASE_URL}/shorten`, payload, params);
  check(postRes, { 'is 201 or 429': (r) => r.status === 201 || r.status === 429 });
  
  // 429 is expected when exercising rate limiting under load.
  if (postRes.status !== 201 && postRes.status !== 429) {
    console.log(`POST Error! Status: ${postRes.status} | Body: ${postRes.body}`);
  }
  
  if (postRes.status === 201) {
    const shortId = postRes.json().id;
    const getRes = http.get(`${BASE_URL}/${shortId}`, { redirects: 0 });
    check(getRes, { 'is redirect': (r) => r.status === 301 || r.status === 302 });
    
    // 🚨 NEW: Print the error if the GET fails
    if (getRes.status !== 301 && getRes.status !== 302) {
       console.log(`GET Error! Status: ${getRes.status} | ID: ${shortId}`);
    }
  }

  sleep(1);
}