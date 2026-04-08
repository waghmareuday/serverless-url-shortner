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

// Generates a random fake IP (e.g., "192.45.12.8") to bypass the single-IP rate limit
function randomIp() {
  return `${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;
}

export default function () {
  const payload = JSON.stringify({ url: 'https://www.google.com' });
  
  const params = { 
    headers: { 
      'Content-Type': 'application/json',
      'x-test-ip': randomIp() 
    } 
  };
  
  const postRes = http.post(`${BASE_URL}/shorten`, payload, params);
  check(postRes, { 'is 201': (r) => r.status === 201 });
  
  // 🚨 NEW: Print the error if the POST fails
  if (postRes.status !== 201) {
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