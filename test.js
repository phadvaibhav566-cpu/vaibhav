'use strict';
const http = require('http');
const assert = require('assert');

function req(opt, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opt, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    r.on('error', reject);
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

async function runTests() {
  console.log('--- Starting Automated Tests for Green Corridor Server ---');

  // 1. Health check
  console.log('[Test 1] Checking /api/health...');
  const h = await req({ host: '127.0.0.1', port: 3000, path: '/api/health', method: 'GET' });
  assert.strictEqual(h.status, 200, 'Health endpoint should return 200');
  assert.strictEqual(h.body.ok, true, 'Health check ok must be true');
  console.log('✓ Health check passed. DB:', h.body.database);

  // 2. Fetch initial state
  console.log('[Test 2] Fetching state /api/state...');
  const st1 = await req({ host: '127.0.0.1', port: 3000, path: '/api/state', method: 'GET' });
  assert.strictEqual(st1.status, 200);
  assert.ok(typeof st1.body.rev === 'number');
  console.log('✓ State endpoint passed. Current rev:', st1.body.rev);

  // 3. 3-way Merge (Simulating Driver creating trip)
  console.log('[Test 3] Simulating Driver Trip Creation via /api/merge...');
  const testTrip = {
    emergencyCode: 'TEST-EMG-' + Date.now(),
    vehicleId: 'DV-TEST-01',
    vehicleType: 'AMBULANCE',
    driverName: 'Ramesh Patil',
    status: 'EN_ROUTE',
    corridorStatus: 'REQUESTED',
    originName: 'Central Bus Stand',
    destHospital: { id: 'HOSP-KOP-001', name: 'CPR Hospital' },
    signals: [{ id: 'SIG-1', name: 'CBS Chowk', status: 'GREEN' }],
    progressFrac: 0.1
  };
  const mergeRes = await req(
    { host: '127.0.0.1', port: 3000, path: '/api/merge', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    { base: st1.body.state, next: { TRIP: testTrip } }
  );
  assert.strictEqual(mergeRes.status, 200);
  assert.strictEqual(mergeRes.body.ok, true);
  console.log('✓ Merge passed. New rev:', mergeRes.body.rev);

  // 4. Verify merged state
  console.log('[Test 4] Verifying state updated across devices...');
  const st2 = await req({ host: '127.0.0.1', port: 3000, path: '/api/state', method: 'GET' });
  assert.strictEqual(st2.body.state.TRIP.emergencyCode, testTrip.emergencyCode);
  assert.strictEqual(st2.body.state.TRIP.vehicleId, 'DV-TEST-01');
  console.log('✓ State verified: Emergency Code is', st2.body.state.TRIP.emergencyCode);

  // 5. Simulating Traffic Police approving corridor concurrently
  console.log('[Test 5] Simulating Traffic Police Corridor Approval...');
  const updatedTrip = Object.assign({}, st2.body.state.TRIP, { corridorStatus: 'ACTIVE' });
  const tpMerge = await req(
    { host: '127.0.0.1', port: 3000, path: '/api/merge', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    { base: st2.body.state, next: { TRIP: updatedTrip } }
  );
  assert.strictEqual(tpMerge.status, 200);
  const st3 = await req({ host: '127.0.0.1', port: 3000, path: '/api/state', method: 'GET' });
  assert.strictEqual(st3.body.state.TRIP.corridorStatus, 'ACTIVE');
  console.log('✓ Traffic Police coordination verified: Corridor Status is ACTIVE');

  console.log('\n=========================================');
  console.log('🎉 ALL AUTOMATED TESTS PASSED WITH 0 ERRORS!');
  console.log('=========================================\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
